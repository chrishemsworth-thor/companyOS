import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope } from "../src/schemas/envelope";
import { handleEventBatch } from "../src/queue/consumer";

const API_KEY = "test_api_key_build";
const TENANT_ID = "biz_build";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function seedTenant() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Build Test SME", await sha256Hex(API_KEY))
    .run();
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createProject(name: string): Promise<{ project_id: string }> {
  const res = await gatewayFetch("/v1/projects", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createIssue(projectId: string, title: string): Promise<{ issue_id: string }> {
  const res = await gatewayFetch("/v1/issues", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ project_id: projectId, title, priority: "high" }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function moveIssue(issueId: string, status: string): Promise<Response> {
  return gatewayFetch(`/v1/issues/${issueId}/status`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ status }),
  });
}

beforeAll(seedTenant);

describe("projects", () => {
  it("creates and lists projects", async () => {
    const { project_id } = await createProject("Website revamp");
    expect(project_id).toMatch(/^prj_/);

    const res = await gatewayFetch(`/v1/projects/${project_id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("active");
  });
});

describe("issues", () => {
  it("creates an issue on a project; unknown project is 404", async () => {
    const { project_id } = await createProject("Q3 work");
    const { issue_id } = await createIssue(project_id, "Fix login bug");
    expect(issue_id).toMatch(/^iss_/);

    const res = await gatewayFetch("/v1/issues", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ project_id: "prj_ghost", title: "Phantom" }),
    });
    expect(res.status).toBe(404);
  });

  it("filters issues by project and status", async () => {
    const { project_id } = await createProject("Filter project");
    const a = await createIssue(project_id, "One");
    const b = await createIssue(project_id, "Two");
    await moveIssue(b.issue_id, "in_progress");

    const res = await gatewayFetch(`/v1/issues?project_id=${project_id}&status=todo`, {
      headers: auth,
    });
    const body = (await res.json()) as { issues: { issue_id: string }[] };
    expect(body.issues.map((i) => i.issue_id)).toEqual([a.issue_id]);
  });

  it("done issues can only be re-opened to todo", async () => {
    const { project_id } = await createProject("Settle project");
    const { issue_id } = await createIssue(project_id, "Ship it");

    expect((await moveIssue(issue_id, "in_progress")).status).toBe(200);
    expect((await moveIssue(issue_id, "done")).status).toBe(200);
    expect((await moveIssue(issue_id, "in_progress")).status).toBe(409);
    expect((await moveIssue(issue_id, "todo")).status).toBe(200);
  });

  it("build events pass the registry and are audit-logged without agent routing", async () => {
    const { project_id } = await createProject("Event project");
    const { issue_id } = await createIssue(project_id, "Evented");
    await moveIssue(issue_id, "done");

    // Feed an issue.completed envelope (no customer_id) through the consumer:
    // it must be logged and acked, not routed or retried.
    const envelope = makeEnvelope({
      event_type: "issue.completed",
      source_module: "build",
      tenant_id: TENANT_ID,
      payload: { issue_id, project_id, completed_at: new Date().toISOString() },
    });
    let acked = 0;
    const batch = {
      queue: "companyos-events",
      messages: [
        {
          id: "msg_1",
          timestamp: new Date(),
          attempts: 1,
          body: envelope,
          ack: () => acked++,
          retry: () => {
            throw new Error("build event should not retry");
          },
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>;

    await handleEventBatch(batch, env);
    expect(acked).toBe(1);

    const logged = await env.DB.prepare("SELECT event_type FROM events_log WHERE event_id = ?")
      .bind(envelope.event_id)
      .first<{ event_type: string }>();
    expect(logged!.event_type).toBe("issue.completed");
  });
});
