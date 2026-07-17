import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

const API_KEY = "test_api_key_webhook_sources";
const TENANT_ID = "biz_webhook_sources";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

let projectId: string;

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createSource(body: Record<string, unknown>): Promise<Response> {
  return gatewayFetch("/v1/webhook-sources", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Webhook Sources SME", await sha256Hex(API_KEY))
    .run();

  const projectRes = await gatewayFetch("/v1/projects", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Provisioning" }),
  });
  projectId = ((await projectRes.json()) as { project_id: string }).project_id;
});

describe("webhook source provisioning", () => {
  it("provisions a source whose one-time secret verifies against the live route", async () => {
    const res = await createSource({ provider: "github", project_id: projectId });
    expect(res.status).toBe(201);
    const source = (await res.json()) as { source_id: string; url: string; secret: string };
    expect(source.source_id).toMatch(/^whs_/);
    expect(source.secret).toMatch(/^[0-9a-f]{64}$/);

    // Sign a ping with the returned secret and deliver it.
    const body = JSON.stringify({ zen: "Practicality beats purity." });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(source.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const ping = await gatewayFetch(new URL(source.url).pathname, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-Hub-Signature-256": `sha256=${hex}`,
      },
      body,
    });
    expect(ping.status).toBe(200);
  });

  it("embeds the secret in the URL for JIRA sources", async () => {
    const res = await createSource({ provider: "jira", project_id: projectId });
    const source = (await res.json()) as { url: string; secret: string };
    const url = new URL(source.url);
    expect(url.pathname).toMatch(/^\/webhooks\/jira\/whs_/);
    expect(url.searchParams.get("secret")).toBe(source.secret);
  });

  it("lists sources without any secret material", async () => {
    await createSource({ provider: "github", project_id: projectId });
    const res = await gatewayFetch("/v1/webhook-sources", { headers: auth });
    expect(res.status).toBe(200);
    const { webhook_sources } = (await res.json()) as { webhook_sources: Record<string, unknown>[] };
    expect(webhook_sources.length).toBeGreaterThan(0);
    for (const source of webhook_sources) {
      expect(source).not.toHaveProperty("secret");
      expect(source).not.toHaveProperty("url");
      expect(source.tenant_id).toBe(TENANT_ID);
    }
  });

  it("rejects unknown projects with 404", async () => {
    const res = await createSource({ provider: "github", project_id: "prj_ghost" });
    expect(res.status).toBe(404);
  });

  it("disabled sources stop accepting deliveries (uniform 404)", async () => {
    const created = await createSource({ provider: "jira", project_id: projectId });
    const source = (await created.json()) as { source_id: string; url: string };

    const del = await gatewayFetch(`/v1/webhook-sources/${source.source_id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(del.status).toBe(200);

    const url = new URL(source.url);
    const delivery = await gatewayFetch(url.pathname + url.search, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookEvent: "jira:issue_created" }),
    });
    expect(delivery.status).toBe(404);

    const otherTenantDelete = await gatewayFetch(`/v1/webhook-sources/whs_ghost`, {
      method: "DELETE",
      headers: auth,
    });
    expect(otherTenantDelete.status).toBe(404);
  });
});
