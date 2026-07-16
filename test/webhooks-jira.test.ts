import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { ingestNormalizedEvent } from "../src/webhooks/ingest";
import { normalizeJira } from "../src/webhooks/normalize/jira";
import type { WebhookSource } from "../src/webhooks/types";
import type { EventEnvelope } from "../src/schemas/envelope";
import type { Env } from "../src/env";

const API_KEY = "test_api_key_webhooks_jira";
const TENANT_ID = "biz_webhooks_jira";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

let projectId: string;
let jiraUrl: string; // /webhooks/jira/<source_id>?secret=<hex>

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Webhook JIRA SME", await sha256Hex(API_KEY))
    .run();

  const projectRes = await gatewayFetch("/v1/projects", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "JIRA mirror" }),
  });
  projectId = ((await projectRes.json()) as { project_id: string }).project_id;

  const sourceRes = await gatewayFetch("/v1/webhook-sources", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ provider: "jira", project_id: projectId, external_project_key: "PROJ" }),
  });
  expect(sourceRes.status).toBe(201);
  const source = (await sourceRes.json()) as { url: string };
  jiraUrl = new URL(source.url).pathname + new URL(source.url).search;
});

function jiraFixture(opts: {
  key: string;
  summary: string;
  event?: string;
  statusCategory?: string;
  resolution?: string;
  priority?: string;
  description?: unknown;
  projectKey?: string;
}): string {
  return JSON.stringify({
    webhookEvent: opts.event ?? "jira:issue_created",
    issue: {
      key: opts.key,
      self: "https://acme.atlassian.net/rest/api/2/issue/10002",
      fields: {
        summary: opts.summary,
        description: opts.description ?? null,
        status: { statusCategory: { key: opts.statusCategory ?? "new" } },
        resolution: opts.resolution ? { name: opts.resolution } : null,
        priority: opts.priority ? { name: opts.priority } : null,
        assignee: { displayName: "Aisha" },
        project: { key: opts.projectKey ?? "PROJ" },
      },
    },
  });
}

async function postJira(body: string, path = jiraUrl): Promise<Response> {
  return gatewayFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function refFor(externalId: string): Promise<{ issue_id: string } | null> {
  return env.DB.prepare(
    "SELECT issue_id FROM external_refs WHERE tenant_id = ? AND provider = 'jira' AND external_id = ?",
  )
    .bind(TENANT_ID, externalId)
    .first<{ issue_id: string }>();
}

async function getIssue(issueId: string): Promise<Record<string, unknown>> {
  const res = await gatewayFetch(`/v1/issues/${issueId}`, { headers: auth });
  expect(res.status).toBe(200);
  return res.json();
}

describe("JIRA webhook ingestion", () => {
  it("mirrors a created issue with mapped priority, provenance, and external ref", async () => {
    const res = await postJira(jiraFixture({ key: "PROJ-1", summary: "Fix login", priority: "Highest" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; issue_id: string };
    expect(body.status).toBe("processed");

    const issue = await getIssue(body.issue_id);
    expect(issue).toMatchObject({
      title: "Fix login",
      status: "todo",
      priority: "urgent",
      assignee: "Aisha",
      origin: "jira",
      project_id: projectId,
    });
    expect((await refFor("PROJ-1"))!.issue_id).toBe(body.issue_id);
  });

  it("re-delivery updates the same issue instead of duplicating", async () => {
    const first = await postJira(jiraFixture({ key: "PROJ-2", summary: "Dup check" }));
    const a = ((await first.json()) as { issue_id: string }).issue_id;
    const second = await postJira(jiraFixture({ key: "PROJ-2", summary: "Dup check (edited)" }));
    const b = ((await second.json()) as { issue_id: string }).issue_id;

    expect(b).toBe(a);
    expect((await getIssue(a)).title).toBe("Dup check (edited)");
  });

  it("statusCategory done → done; cancelled resolutions → cancelled; delete → cancelled", async () => {
    const created = await postJira(jiraFixture({ key: "PROJ-3", summary: "Ship it" }));
    const issueId = ((await created.json()) as { issue_id: string }).issue_id;

    await postJira(
      jiraFixture({ key: "PROJ-3", summary: "Ship it", event: "jira:issue_updated", statusCategory: "done" }),
    );
    expect((await getIssue(issueId)).status).toBe("done");

    const wontdo = await postJira(
      jiraFixture({ key: "PROJ-4", summary: "Nope", statusCategory: "done", resolution: "Won't Do" }),
    );
    const wontdoId = ((await wontdo.json()) as { issue_id: string }).issue_id;
    expect((await getIssue(wontdoId)).status).toBe("cancelled");

    const del = await postJira(jiraFixture({ key: "PROJ-5", summary: "Bye", event: "jira:issue_deleted" }));
    const delId = ((await del.json()) as { issue_id: string }).issue_id;
    expect((await getIssue(delId)).status).toBe("cancelled");
  });

  it("reopens a settled issue via todo when JIRA jumps straight to in_progress", async () => {
    await postJira(jiraFixture({ key: "PROJ-6", summary: "Zombie" }));
    await postJira(
      jiraFixture({ key: "PROJ-6", summary: "Zombie", event: "jira:issue_updated", statusCategory: "done" }),
    );
    const res = await postJira(
      jiraFixture({
        key: "PROJ-6",
        summary: "Zombie",
        event: "jira:issue_updated",
        statusCategory: "indeterminate",
      }),
    );
    expect(res.status).toBe(200);
    const issueId = (await refFor("PROJ-6"))!.issue_id;
    expect((await getIssue(issueId)).status).toBe("in_progress");
  });

  it("the two-step reopen emits two honest status_changed events", async () => {
    // Drive ingest directly with a stub queue so the service-emitted
    // envelopes are observable (the HTTP path uses the real binding).
    await env.DB.prepare(
      `INSERT OR IGNORE INTO webhook_sources (source_id, tenant_id, provider, project_id)
       VALUES ('whs_stub', ?, 'jira', ?)`,
    )
      .bind(TENANT_ID, projectId)
      .run();
    const sent: EventEnvelope[] = [];
    const stubEnv = { ...env, EVENTS: { send: async (m: unknown) => void sent.push(m as EventEnvelope) } } as unknown as Env;
    const source: WebhookSource = {
      source_id: "whs_stub",
      tenant_id: TENANT_ID,
      provider: "jira",
      project_id: projectId,
      external_project_key: null,
      status: "active",
      created_at: "",
    };
    const upsert = (statusCategory: string) =>
      ingestNormalizedEvent(
        stubEnv,
        source,
        normalizeJira(JSON.parse(jiraFixture({ key: "PROJ-7", summary: "Trail", statusCategory }))),
      );

    await upsert("new");
    await upsert("done");
    sent.length = 0;
    await upsert("indeterminate");

    const transitions = sent
      .filter((e) => e.event_type === "issue.status_changed")
      .map((e) => `${String(e.payload.from)}→${String(e.payload.to)}`);
    expect(transitions).toEqual(["done→todo", "todo→in_progress"]);
    expect(sent.every((e) => e.actor === undefined || e.actor.type === "system")).toBe(true);
  });

  it("flattens ADF descriptions to plain text", async () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Line one" }] },
        { type: "paragraph", content: [{ type: "text", text: "Line two" }] },
      ],
    };
    const res = await postJira(jiraFixture({ key: "PROJ-8", summary: "ADF", description: adf }));
    const issueId = ((await res.json()) as { issue_id: string }).issue_id;
    expect((await getIssue(issueId)).description).toBe("Line one\nLine two");
  });

  it("ignores deliveries for other JIRA projects (source filter)", async () => {
    const res = await postJira(jiraFixture({ key: "OTHER-1", summary: "Wrong project", projectKey: "OTHER" }));
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("ignored");
    expect(await refFor("OTHER-1")).toBeNull();
  });

  it("rejects a wrong URL secret with 401 and unknown sources with 404", async () => {
    const [path] = jiraUrl.split("?");
    const badSecret = await postJira(jiraFixture({ key: "PROJ-9", summary: "x" }), `${path}?secret=${"0".repeat(64)}`);
    expect(badSecret.status).toBe(401);

    const unknown = await postJira(jiraFixture({ key: "PROJ-9", summary: "x" }), "/webhooks/jira/whs_ghost?secret=abc");
    expect(unknown.status).toBe(404);

    const wrongProvider = await postJira(jiraFixture({ key: "PROJ-9", summary: "x" }), "/webhooks/nope/whs_ghost");
    expect(wrongProvider.status).toBe(404);
  });

  it("fails closed with 503 when WEBHOOK_MASTER_SECRET is unset", async () => {
    const saved = env.WEBHOOK_MASTER_SECRET;
    delete (env as { WEBHOOK_MASTER_SECRET?: string }).WEBHOOK_MASTER_SECRET;
    try {
      expect((await postJira(jiraFixture({ key: "PROJ-10", summary: "x" }))).status).toBe(503);
      const provision = await gatewayFetch("/v1/webhook-sources", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ provider: "jira", project_id: projectId }),
      });
      expect(provision.status).toBe(503);
    } finally {
      env.WEBHOOK_MASTER_SECRET = saved;
    }
  });
});
