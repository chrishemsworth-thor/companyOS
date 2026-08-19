import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import type { Role } from "../src/auth/roles";

/**
 * The settings the guardrails read: the tenant's local time (SESSION-PLAN
 * conflict C6 — it existed nowhere in `src/` before this session) and the
 * tenant-configurable guardrail policy.
 *
 * The policy surface is on the settings axis so a finance or support user can
 * see what the agent is allowed to do; changing it — including the kill switch —
 * is held to `agents:write`.
 */

const API_KEY = "test_api_key_agentsettings";
const TENANT_ID = "biz_agentset";
const WORKSPACE = "agentset-co";
const ORIGIN = "http://localhost:5173";
const PASSWORD = "agent-settings-password";
const CUSTOMER_ID = "cust_agentset_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const sessions = new Map<Role, { cookie: string; csrf: string }>();

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace: WORKSPACE, email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { csrf_token: string };
  return { cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "", csrf: body.csrf_token };
}

function asRole(role: Role, path: string, method = "GET", body?: unknown): Promise<Response> {
  const session = sessions.get(role)!;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: ORIGIN,
    Cookie: session.cookie,
  };
  if (method !== "GET") headers["X-CSRF-Token"] = session.csrf;
  return fetchWorker(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const PROFILE = { legal_name: "Agent Settings Sdn Bhd" };

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(TENANT_ID, "Agent Settings SME", WORKSPACE, await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Paused Co", "2026-01-01T00:00:00.000Z")
    .run();
  for (const role of ["admin", "finance", "readonly", "employee"] as Role[]) {
    const user = await createUser(env.DB, {
      tenant_id: TENANT_ID,
      email: `${role}@agentset.test`,
      password: PASSWORD,
      role,
    });
    sessions.set(role, await login(user.email));
  }
});

describe("tenant timezone (conflict C6)", () => {
  it("defaults to Malaysia when a profile is saved without one", async () => {
    const res = await fetchWorker("/v1/settings/company-profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify(PROFILE),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ timezone: "Asia/Kuala_Lumpur" });
  });

  it("accepts an IANA zone name and reads it back", async () => {
    await fetchWorker("/v1/settings/company-profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ ...PROFILE, timezone: "Asia/Singapore" }),
    });
    const res = await fetchWorker("/v1/settings/company-profile", { headers: auth });
    expect((await res.json()) as unknown).toMatchObject({
      company_profile: { timezone: "Asia/Singapore" },
    });
  });

  it("refuses a zone name ICU does not know", async () => {
    // Validated against Intl rather than a hardcoded list: the zone database
    // changes and our list would not.
    for (const timezone of ["Mars/Olympus_Mons", "GMT+8", "Kuala Lumpur", "utc+8"]) {
      const res = await fetchWorker("/v1/settings/company-profile", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ ...PROFILE, timezone }),
      });
      expect(res.status, timezone).toBe(400);
    }
  });

  it("keeps accepting the zones a Malaysian SME with regional staff would set", async () => {
    for (const timezone of ["Asia/Kuala_Lumpur", "Asia/Kuching", "Asia/Jakarta", "UTC"]) {
      const res = await fetchWorker("/v1/settings/company-profile", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ ...PROFILE, timezone }),
      });
      expect(res.status, timezone).toBe(200);
    }
  });
});

describe("GET /v1/settings/agents", () => {
  it("serves the decided defaults for a tenant that has never saved settings", async () => {
    const res = await fetchWorker("/v1/settings/agents", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: false,
      enabled: true,
      timezone: "Asia/Kuala_Lumpur",
      contact_window_start_hour: 9,
      contact_window_end_hour: 18,
      suppress_weekends: true,
      suppress_holidays: true,
      max_reminders_per_invoice: 5,
      escalation_threshold_days: 60,
      contact_cooldown_hours: 24,
      max_message_chars: 2000,
      work_week: [0, 1, 1, 1, 1, 1, 0],
    });
  });

  it("reflects the tenant's own timezone and work week", async () => {
    await fetchWorker("/v1/settings/company-profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ ...PROFILE, timezone: "Asia/Kuching" }),
    });
    // The work week belongs to the people module; the guard reads it rather than
    // storing a second copy.
    await env.DB.prepare(
      "INSERT INTO leave_settings (tenant_id, work_week) VALUES (?, '[0,1,1,1,1,1,0.5]') ON CONFLICT (tenant_id) DO UPDATE SET work_week = excluded.work_week",
    )
      .bind(TENANT_ID)
      .run();

    const res = await fetchWorker("/v1/settings/agents", { headers: auth });
    expect(await res.json()).toMatchObject({
      timezone: "Asia/Kuching",
      work_week: [0, 1, 1, 1, 1, 1, 0.5],
    });
  });
});

describe("PUT /v1/settings/agents", () => {
  it("saves a partial change and leaves everything else alone", async () => {
    const res = await fetchWorker("/v1/settings/agents", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ escalation_threshold_days: 90 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: true,
      escalation_threshold_days: 90,
      // Untouched, not reset — a console form that predates a new bound must
      // not silently clear it.
      max_reminders_per_invoice: 5,
      contact_window_start_hour: 9,
      enabled: true,
    });

    const after = await fetchWorker("/v1/settings/agents", { headers: auth });
    expect(await after.json()).toMatchObject({ escalation_threshold_days: 90, configured: true });
  });

  it("flips the kill switch", async () => {
    const res = await fetchWorker("/v1/settings/agents", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    });
    expect(await res.json()).toMatchObject({ enabled: false });
  });

  it("stores a tenant that trades weekends and holidays", async () => {
    const res = await fetchWorker("/v1/settings/agents", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ suppress_weekends: false, suppress_holidays: false }),
    });
    expect(await res.json()).toMatchObject({
      suppress_weekends: false,
      suppress_holidays: false,
    });
  });

  it("refuses a window that closes before it opens", async () => {
    const res = await fetchWorker("/v1/settings/agents", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ contact_window_start_hour: 18, contact_window_end_hour: 9 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
  });

  it("refuses a window that closes the hour it opens", async () => {
    const res = await fetchWorker("/v1/settings/agents", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ contact_window_start_hour: 9, contact_window_end_hour: 9 }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses values outside the sane range", async () => {
    const bad: Record<string, unknown>[] = [
      { escalation_threshold_days: 0 }, // escalating on the due date is not a policy
      { escalation_threshold_days: 400 },
      { max_reminders_per_invoice: 0 },
      { contact_cooldown_hours: 0 },
      { max_message_chars: 10 },
      { contact_window_start_hour: 24 },
      { contact_window_end_hour: 25 },
      { enabled: "no" },
      {},
    ];
    for (const body of bad) {
      const res = await fetchWorker("/v1/settings/agents", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("who may see and change the agent's bounds", () => {
  it("lets an admin read and write", async () => {
    expect((await asRole("admin", "/v1/settings/agents")).status).toBe(200);
    expect(
      (await asRole("admin", "/v1/settings/agents", "PUT", { enabled: true })).status,
    ).toBe(200);
  });

  it("lets a finance user read the bounds but not change them", async () => {
    expect((await asRole("finance", "/v1/settings/agents")).status).toBe(200);
    const res = await asRole("finance", "/v1/settings/agents", "PUT", { enabled: false });
    expect(res.status).toBe(403);
  });

  it("refuses a readonly observer the write, and the employee tier the read", async () => {
    expect((await asRole("readonly", "/v1/settings/agents")).status).toBe(200);
    expect((await asRole("readonly", "/v1/settings/agents", "PUT", { enabled: false })).status).toBe(
      403,
    );
    expect((await asRole("employee", "/v1/settings/agents")).status).toBe(403);
  });
});

describe("the per-customer pause", () => {
  it("defaults to false and is patchable on the customer", async () => {
    const before = await fetchWorker(`/v1/customers/${CUSTOMER_ID}`, { headers: auth });
    expect(await before.json()).toMatchObject({ agent_paused: false });

    const patch = await fetchWorker(`/v1/customers/${CUSTOMER_ID}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ agent_paused: true }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ agent_paused: true });

    const list = await fetchWorker("/v1/customers", { headers: auth });
    const body = (await list.json()) as { customers: { customer_id: string; agent_paused: boolean }[] };
    expect(body.customers.find((c) => c.customer_id === CUSTOMER_ID)).toMatchObject({
      agent_paused: true,
    });
  });

  it("is a CRM write, so a support user cannot pause the agent", async () => {
    const res = await asRole("employee", `/v1/customers/${CUSTOMER_ID}`, "PATCH", {
      agent_paused: true,
    });
    expect(res.status).toBe(403);
  });

  it("refuses a non-boolean pause", async () => {
    const res = await fetchWorker(`/v1/customers/${CUSTOMER_ID}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ agent_paused: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});
