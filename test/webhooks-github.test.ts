import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { setEventSenderForTests } from "../src/queue/producer";
import { handleEventBatch } from "../src/queue/consumer";
import type { EventEnvelope } from "../src/schemas/envelope";

const API_KEY = "test_api_key_webhooks_github";
const TENANT_ID = "biz_webhooks_github";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

let projectId: string;
let webhookPath: string; // /webhooks/github/<source_id>
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

async function postGithub(
  event: string,
  body: string,
  opts: { deliveryId?: string; signature?: string } = {},
): Promise<Response> {
  return gatewayFetch(webhookPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": opts.signature ?? (await sign(body)),
      ...(opts.deliveryId ? { "X-GitHub-Delivery": opts.deliveryId } : {}),
    },
    body,
  });
}

function issueFixture(opts: {
  number: number;
  action?: string;
  state?: string;
  state_reason?: string | null;
  title?: string;
}): string {
  return JSON.stringify({
    action: opts.action ?? "opened",
    repository: { full_name: "acme/api" },
    sender: { login: "octocat" },
    issue: {
      number: opts.number,
      title: opts.title ?? `Issue ${opts.number}`,
      body: "details",
      state: opts.state ?? "open",
      state_reason: opts.state_reason ?? null,
      html_url: `https://github.com/acme/api/issues/${opts.number}`,
      assignee: { login: "hubber" },
    },
  });
}

async function issueByRef(externalId: string): Promise<Record<string, unknown> | null> {
  const ref = await env.DB.prepare(
    "SELECT issue_id FROM external_refs WHERE tenant_id = ? AND provider = 'github' AND external_id = ?",
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
    .bind(TENANT_ID, "Webhook GitHub SME", await sha256Hex(API_KEY))
    .run();

  const projectRes = await gatewayFetch("/v1/projects", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "GitHub mirror" }),
  });
  projectId = ((await projectRes.json()) as { project_id: string }).project_id;

  const sourceRes = await gatewayFetch("/v1/webhook-sources", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ provider: "github", project_id: projectId }),
  });
  const source = (await sourceRes.json()) as { source_id: string; url: string; secret: string };
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

describe("GitHub webhook ingestion", () => {
  it("answers ping and mirrors the issue lifecycle", async () => {
    const ping = await postGithub("ping", JSON.stringify({ zen: "Keep it logically awesome." }));
    expect(ping.status).toBe(200);

    await postGithub("issues", issueFixture({ number: 1 }));
    expect(await issueByRef("acme/api#1")).toMatchObject({
      title: "Issue 1",
      status: "todo",
      priority: "medium",
      assignee: "hubber",
      origin: "github",
    });

    await postGithub("issues", issueFixture({ number: 1, action: "closed", state: "closed", state_reason: "completed" }));
    expect((await issueByRef("acme/api#1"))!.status).toBe("done");

    await postGithub("issues", issueFixture({ number: 2, action: "closed", state: "closed", state_reason: "not_planned" }));
    expect((await issueByRef("acme/api#2"))!.status).toBe("cancelled");

    await postGithub("issues", issueFixture({ number: 1, action: "reopened", state: "open" }));
    expect((await issueByRef("acme/api#1"))!.status).toBe("todo");

    await postGithub("issues", issueFixture({ number: 1, action: "edited", title: "Issue 1 (renamed)" }));
    expect((await issueByRef("acme/api#1"))!.title).toBe("Issue 1 (renamed)");
  });

  it("push and merged PRs become code.* events that the consumer audit-logs", async () => {
    await postGithub(
      "push",
      JSON.stringify({
        repository: { full_name: "acme/api" },
        sender: { login: "octocat" },
        ref: "refs/heads/main",
        commits: [{}, {}, {}],
        compare: "https://github.com/acme/api/compare/a...b",
      }),
    );
    await postGithub(
      "pull_request",
      JSON.stringify({
        action: "closed",
        repository: { full_name: "acme/api" },
        sender: { login: "octocat" },
        pull_request: {
          number: 7,
          title: "Add webhooks",
          merged: true,
          head: { ref: "feat/webhooks" },
          base: { ref: "main" },
          html_url: "https://github.com/acme/api/pull/7",
        },
      }),
    );

    expect(captured.map((e) => e.event_type)).toEqual(["code.push", "code.pr_merged"]);
    expect(captured[0]!.payload).toMatchObject({ provider: "github", repo: "acme/api", commit_count: 3 });
    expect(captured[0]!.actor).toEqual({ type: "system", id: "webhook:github" });

    // Feed the captured envelopes through the queue consumer: registered,
    // audit-logged, acked — never routed or retried.
    let acked = 0;
    const batch = {
      queue: "companyos-events",
      messages: captured.map((envelope, i) => ({
        id: `msg_${i}`,
        timestamp: new Date(),
        attempts: 1,
        body: envelope,
        ack: () => acked++,
        retry: () => {
          throw new Error("code events should not retry");
        },
      })),
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>;
    await handleEventBatch(batch, env);
    expect(acked).toBe(2);

    const logged = await env.DB.prepare(
      "SELECT event_type FROM events_log WHERE event_id = ?",
    )
      .bind(captured[1]!.event_id)
      .first<{ event_type: string }>();
    expect(logged!.event_type).toBe("code.pr_merged");
  });

  it("rejects tampered bodies with 401", async () => {
    const body = issueFixture({ number: 3 });
    const signatureOfOtherBody = await sign(issueFixture({ number: 4 }));
    const res = await postGithub("issues", body, { signature: signatureOfOtherBody });
    expect(res.status).toBe(401);
    expect(await issueByRef("acme/api#3")).toBeNull();
  });

  it("replays the stored response for a redelivered X-GitHub-Delivery id", async () => {
    const body = issueFixture({ number: 5 });
    const first = await postGithub("issues", body, { deliveryId: "dlv-123" });
    const firstBody = (await first.json()) as { issue_id: string };

    const replay = await postGithub("issues", body, { deliveryId: "dlv-123" });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { issue_id: string }).issue_id).toBe(firstBody.issue_id);

    const { results } = await env.DB.prepare(
      "SELECT issue_id FROM external_refs WHERE tenant_id = ? AND external_id = 'acme/api#5'",
    )
      .bind(TENANT_ID)
      .all();
    expect(results.length).toBe(1);
  });
});
