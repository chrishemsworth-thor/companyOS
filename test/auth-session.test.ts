import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { runWithActor } from "../src/auth/actor-context";
import { makeEnvelope, type EventEnvelope } from "../src/schemas/envelope";
import { handleEventBatch } from "../src/queue/consumer";

/**
 * Phase A — human identity & access. Session (cookie) auth for humans coexists
 * with the existing tenant-API-key path for agents, with CSRF on cookie writes,
 * role gating on admin surfaces, and per-user audit attribution on emitted events.
 */

const API_KEY = "test_api_key_auth";
const TENANT_ID = "biz_auth";
const ORIGIN = "http://localhost:5173";

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Log in and return the session cookie + csrf token. */
async function login(email: string, password: string) {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const body = (await res.json()) as { csrf_token?: string; user?: { role: string } };
  return { status: res.status, cookie, csrf: body.csrf_token, user: body.user };
}

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)")
    .bind(TENANT_ID, "Auth Tenant", await sha256Hex(API_KEY))
    .run();
  await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: "admin@auth.test",
    password: "correct horse battery",
    role: "admin",
  });
  await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: "viewer@auth.test",
    password: "read only please",
    role: "readonly",
  });
});

describe("login + session", () => {
  it("logs in with correct credentials and issues an HttpOnly session cookie", async () => {
    const { status, cookie, csrf } = await login("admin@auth.test", "correct horse battery");
    expect(status).toBe(200);
    expect(cookie).toMatch(/^cos_session=/);
    expect(csrf).toBeTruthy();
  });

  it("rejects wrong password with 401 and no cookie", async () => {
    const res = await fetchWorker("/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@auth.test", password: "nope" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("GET /v1/auth/me returns the user for a valid session", async () => {
    const { cookie } = await login("admin@auth.test", "correct horse battery");
    const res = await fetchWorker("/v1/auth/me", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string; role: string } };
    expect(body.user.email).toBe("admin@auth.test");
    expect(body.user.role).toBe("admin");
  });

  it("logout clears the session so /me is 401 afterwards", async () => {
    const { cookie } = await login("admin@auth.test", "correct horse battery");
    await fetchWorker("/v1/auth/logout", { method: "POST", headers: { Cookie: cookie } });
    const res = await fetchWorker("/v1/auth/me", { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
  });
});

describe("session authorizes business routes", () => {
  it("resolves the tenant on a GET via the session cookie", async () => {
    const { cookie } = await login("admin@auth.test", "correct horse battery");
    const res = await fetchWorker("/v1/customers", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it("rejects a tampered session cookie with 401", async () => {
    const { cookie } = await login("admin@auth.test", "correct horse battery");
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("aa") ? "bb" : "aa");
    const res = await fetchWorker("/v1/customers", { headers: { Cookie: tampered } });
    expect(res.status).toBe(401);
  });

  it("blocks a mutating request without a CSRF token (403), allows it with one", async () => {
    const { cookie, csrf } = await login("admin@auth.test", "correct horse battery");
    const body = JSON.stringify({ name: "CSRF Co" });

    const without = await fetchWorker("/v1/customers", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body,
    });
    expect(without.status).toBe(403);

    const withToken = await fetchWorker("/v1/customers", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf! },
      body,
    });
    expect(withToken.status).toBe(201);
  });
});

describe("api-key path still works alongside sessions", () => {
  it("accepts a bearer key on the same routes", async () => {
    const res = await fetchWorker("/v1/customers", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it("401s a request with neither cookie nor bearer", async () => {
    expect((await fetchWorker("/v1/customers")).status).toBe(401);
  });
});

describe("role gating on /v1/users", () => {
  it("lets an admin session list users", async () => {
    const { cookie } = await login("admin@auth.test", "correct horse battery");
    const res = await fetchWorker("/v1/users", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it("forbids a readonly user from listing users (403)", async () => {
    const { cookie } = await login("viewer@auth.test", "read only please");
    const res = await fetchWorker("/v1/users", { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it("lets a tenant-API-key (system) caller bootstrap a user", async () => {
    const res = await fetchWorker("/v1/users", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "boot@auth.test", password: "bootstrap-pass", role: "operator" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("audit attribution", () => {
  it("stamps the acting user onto emitted events via the actor context", async () => {
    const envelope = runWithActor({ type: "user", id: "usr_attrib", role: "finance" }, () =>
      makeEnvelope({
        event_type: "customer.created",
        source_module: "sales",
        tenant_id: TENANT_ID,
        payload: { customer_id: "cust_attrib", name: "Attributed" },
      }),
    );
    expect(envelope.actor).toEqual({ type: "user", id: "usr_attrib", role: "finance" });

    const batch = {
      queue: "companyos-events",
      messages: [
        { id: "m1", timestamp: new Date(), attempts: 1, body: envelope as EventEnvelope, ack() {}, retry() {} },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<unknown>;
    await handleEventBatch(batch, env);

    const row = await env.DB.prepare(
      "SELECT actor_type, actor_id FROM events_log WHERE event_id = ?",
    )
      .bind(envelope.event_id)
      .first<{ actor_type: string; actor_id: string }>();
    expect(row).toEqual({ actor_type: "user", actor_id: "usr_attrib" });
  });
});
