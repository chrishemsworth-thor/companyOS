import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { setEventSenderForTests } from "../src/queue/producer";
import type { EventEnvelope } from "../src/schemas/envelope";

const API_KEY = "test_api_key_webhooks_bitbucket";
const TENANT_ID = "biz_webhooks_bb";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

let projectId: string;
let webhookPath: string; // /webhooks/bitbucket/<source_id>
let secret: string;

const captured: EventEnvelope[] = [];

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postBitbucket(
  eventKey: string,
  body: string,
  opts: { signature?: string } = {},
): Promise<Response> {
  return gatewayFetch(webhookPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Event-Key": eventKey,
      "X-Hub-Signature": opts.signature ?? (await sign(body)),
      "X-Request-UUID": crypto.randomUUID(),
    },
    body,
  });
}

function issueFixture(opts: {
  id: number;
  state?: string;
  priority?: string;
  repo?: string;
}): string {
  const repo = opts.repo ?? "acme/legacy";
  return JSON.stringify({
    repository: { full_name: repo },
    actor: { display_name: "Sam" },
    issue: {
      id: opts.id,
      title: `BB issue ${opts.id}`,
      content: { raw: "It broke." },
      state: opts.state ?? "new",
      priority: opts.priority ?? "major",
      assignee: { display_name: "Sam" },
      links: { html: { href: `https://bitbucket.org/${repo}/issues/${opts.id}` } },
    },
  });
}

async function issueByRef(externalId: string): Promise<Record<string, unknown> | null> {
  const ref = await env.DB.prepare(
    "SELECT issue_id FROM external_refs WHERE tenant_id = ? AND provider = 'bitbucket' AND external_id = ?",
  )
    .bind(TENANT_ID, externalId)
    .first<{ issue_id: string }>();
  if (!ref) return null;
  const res = await gatewayFetch(`/v1/issues/${ref.issue_id}`, { headers: auth });
  return res.json();
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Webhook Bitbucket SME", await sha256Hex(API_KEY))
    .run();

  const projectRes = await gatewayFetch("/v1/projects", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Bitbucket mirror" }),
  });
  projectId = ((await projectRes.json()) as { project_id: string }).project_id;

  const sourceRes = await gatewayFetch("/v1/webhook-sources", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      provider: "bitbucket",
      project_id: projectId,
      external_project_key: "acme/legacy",
    }),
  });
  const source = (await sourceRes.json()) as { url: string; secret: string };
  webhookPath = new URL(source.url).pathname;
  secret = source.secret;
});

beforeEach(() => {
  captured.length = 0;
  setEventSenderForTests(async (_env, envelope) => {
    captured.push(envelope);
  });
});

afterEach(() => setEventSenderForTests(null));

describe("Bitbucket webhook ingestion", () => {
  it("mirrors issues with mapped state and priority", async () => {
    const res = await postBitbucket("issue:created", issueFixture({ id: 1, priority: "blocker" }));
    expect(res.status).toBe(200);
    expect(await issueByRef("acme/legacy#1")).toMatchObject({
      title: "BB issue 1",
      status: "todo",
      priority: "urgent",
      origin: "bitbucket",
    });

    await postBitbucket("issue:updated", issueFixture({ id: 1, state: "wontfix" }));
    expect((await issueByRef("acme/legacy#1"))!.status).toBe("cancelled");
  });

  it("a fulfilled pull request becomes code.pr_merged", async () => {
    const res = await postBitbucket(
      "pullrequest:fulfilled",
      JSON.stringify({
        repository: { full_name: "acme/legacy" },
        actor: { display_name: "Sam" },
        pullrequest: {
          id: 9,
          title: "Port to Workers",
          source: { branch: { name: "feature" } },
          destination: { branch: { name: "main" } },
          links: { html: { href: "https://bitbucket.org/acme/legacy/pull-requests/9" } },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(captured.map((e) => e.event_type)).toEqual(["code.pr_merged"]);
    expect(captured[0]!.payload).toMatchObject({
      provider: "bitbucket",
      repo: "acme/legacy",
      external_id: "acme/legacy#9",
      source_branch: "feature",
      target_branch: "main",
    });
  });

  it("rejects a missing or wrong X-Hub-Signature with 401", async () => {
    const body = issueFixture({ id: 2 });
    const bad = await postBitbucket("issue:created", body, { signature: "sha256=" + "0".repeat(64) });
    expect(bad.status).toBe(401);

    const missing = await gatewayFetch(webhookPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Event-Key": "issue:created" },
      body,
    });
    expect(missing.status).toBe(401);
    expect(await issueByRef("acme/legacy#2")).toBeNull();
  });

  it("ignores deliveries from other repos (source filter) with 202", async () => {
    const res = await postBitbucket("issue:created", issueFixture({ id: 3, repo: "acme/other" }));
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("ignored");
    expect(await issueByRef("acme/other#3")).toBeNull();
  });
});
