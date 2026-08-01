import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import type { LeavePolicy, LeaveType, StatutoryWarning } from "../src/modules/leave/types";

/**
 * PRD-006b — leave types, policies and entitlement bands.
 *
 * The load-bearing test in this file is the statutory one. PRD-006 says
 * Employment Act minimums are *"a seed default and a warning, not an enforced
 * floor — a tenant may have contractual terms above minimum and the system must
 * not fight them"*, so every below-minimum case here asserts BOTH that the
 * warning appears AND that the policy actually saved with the value as entered.
 * A test that only checked for the warning would pass against an implementation
 * that rejected the write.
 */

const API_KEY = "test_api_key_leave_policy";
const TENANT_ID = "biz_leave_policy";
const WORKSPACE = "leave-policy-co";
const OTHER_API_KEY = "test_api_key_leave_policy_other";
const OTHER_TENANT_ID = "biz_leave_policy_other";
const ORIGIN = "http://localhost:5173";

const bearer = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const otherBearer = { Authorization: `Bearer ${OTHER_API_KEY}`, "Content-Type": "application/json" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function login(email: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace: WORKSPACE, email, password }),
  });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const body = (await res.json()) as { csrf_token: string };
  return { cookie, csrf: body.csrf_token };
}

function sessionHeaders(session: { cookie: string; csrf: string }): Record<string, string> {
  return {
    Cookie: session.cookie,
    "X-CSRF-Token": session.csrf,
    Origin: ORIGIN,
    "Content-Type": "application/json",
  };
}

async function listTypes(headers = bearer): Promise<LeaveType[]> {
  const res = await fetchWorker("/v1/people/leave/types", { headers });
  return ((await res.json()) as { leave_types: LeaveType[] }).leave_types;
}

async function typeByCode(code: string, headers = bearer): Promise<LeaveType> {
  const types = await listTypes(headers);
  const found = types.find((t) => t.code === code);
  if (!found) throw new Error(`no seeded leave type '${code}'`);
  return found;
}

interface PolicyBody {
  policy: LeavePolicy;
  warnings: StatutoryWarning[];
  error?: string;
  code?: string;
}

async function createPolicy(
  body: Record<string, unknown>,
  headers = bearer,
): Promise<{ status: number; body: PolicyBody }> {
  const res = await fetchWorker("/v1/people/leave/policies", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as PolicyBody };
}

beforeAll(async () => {
  for (const [tenantId, name, slug, key] of [
    [TENANT_ID, "Leave Policy Tenant", WORKSPACE, API_KEY],
    [OTHER_TENANT_ID, "Other Tenant", "leave-policy-other-co", OTHER_API_KEY],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(tenantId, name, slug, await sha256Hex(key))
      .run();
  }
  for (const [email, role] of [
    ["admin@leavepolicy.test", "admin"],
    ["op@leavepolicy.test", "operator"],
    ["ro@leavepolicy.test", "readonly"],
    ["staff@leavepolicy.test", "employee"],
    ["fin@leavepolicy.test", "finance"],
  ] as const) {
    await createUser(env.DB, {
      tenant_id: TENANT_ID,
      email,
      password: `${role}-password`,
      role,
    });
  }
});

describe("Malaysian leave-type defaults", () => {
  it("seeds the seven PRD-006 types on first read, with statutory bases attached", async () => {
    const types = await listTypes();
    expect(types.map((t) => t.code).sort()).toEqual([
      "annual",
      "compassionate",
      "hospitalisation",
      "maternity",
      "paternity",
      "sick",
      "unpaid",
    ]);

    const annual = types.find((t) => t.code === "annual")!;
    expect(annual).toMatchObject({
      is_paid: true,
      carry_forward_allowed: true,
      allows_half_day: true,
      statutory_basis: "annual",
    });

    // Sick leave needs a medical certificate; unpaid leave is the one type
    // allowed to run negative.
    expect(types.find((t) => t.code === "sick")!.requires_attachment).toBe(true);
    expect(types.find((t) => t.code === "unpaid")).toMatchObject({
      is_paid: false,
      allow_negative_balance: true,
      statutory_basis: null,
    });
    // Compassionate has no statutory floor, so it can never produce a warning.
    expect(types.find((t) => t.code === "compassionate")!.statutory_basis).toBeNull();
  });

  it("seeds a default policy per type at the Employment Act minimums", async () => {
    const annual = await typeByCode("annual");
    const res = await fetchWorker(
      `/v1/people/leave/policies?leave_type_id=${annual.leave_type_id}`,
      { headers: bearer },
    );
    const { policies } = (await res.json()) as { policies: LeavePolicy[] };
    expect(policies).toHaveLength(1);
    const policy = policies[0]!;
    expect(policy.is_default).toBe(true);
    expect(policy.accrual_method).toBe("annual_upfront");
    // Carry-forward is a real Malaysian norm, so the default policy ships one.
    expect(policy.carry_forward_max_days).toBe(5);
    expect(policy.carry_forward_expiry_months).toBe(3);
    expect(policy.bands.map((b) => [b.min_months_service, b.max_months_service, b.entitlement_days])).toEqual([
      [0, 24, 8],
      [24, 60, 12],
      [60, null, 16],
    ]);
  });

  it("seeds once — an archived type does not come back on the next read", async () => {
    const compassionate = await typeByCode("compassionate");
    const archive = await fetchWorker(`/v1/people/leave/types/${compassionate.leave_type_id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ archived: true }),
    });
    expect(archive.status).toBe(200);

    const after = await listTypes();
    expect(after.map((t) => t.code)).not.toContain("compassionate");

    // Still there, archived, when explicitly asked for — no hard deletes.
    const res = await fetchWorker("/v1/people/leave/types?include_archived=true", {
      headers: bearer,
    });
    const { leave_types: all } = (await res.json()) as { leave_types: LeaveType[] };
    expect(all.find((t) => t.code === "compassionate")!.archived_at).toBeTruthy();
  });

  it("keeps each tenant's edits to its own", async () => {
    await fetchWorker("/v1/people/leave/types", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ code: "study", name: "Study Leave" }),
    });
    expect((await listTypes()).map((t) => t.code)).toContain("study");
    expect((await listTypes(otherBearer)).map((t) => t.code)).not.toContain("study");
  });

  it("409s a duplicate leave-type code", async () => {
    const res = await fetchWorker("/v1/people/leave/types", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ code: "annual", name: "Annual Leave (duplicate)" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "code_taken" });
  });
});

describe("statutory minimums are a warning, never a floor", () => {
  /**
   * PRD-006 acceptance criterion: "Given an entitlement below the statutory
   * minimum for that tenure, then the tenant is warned on save but not blocked."
   */
  it("saves a below-minimum annual entitlement and warns", async () => {
    const annual = await typeByCode("annual");
    const { status, body } = await createPolicy({
      leave_type_id: annual.leave_type_id,
      name: "Probation — 5 days",
      bands: [{ min_months_service: 0, max_months_service: 24, entitlement_days: 5 }],
    });

    // Not blocked.
    expect(status).toBe(201);
    // Saved exactly as entered — the system does not quietly raise it to 8.
    expect(body.policy.bands).toHaveLength(1);
    expect(body.policy.bands[0]!.entitlement_days).toBe(5);
    // And readable back, so the write really landed.
    const res = await fetchWorker(`/v1/people/leave/policies?leave_type_id=${annual.leave_type_id}`, {
      headers: bearer,
    });
    const { policies } = (await res.json()) as { policies: LeavePolicy[] };
    expect(policies.find((p) => p.policy_id === body.policy.policy_id)!.bands[0]!.entitlement_days).toBe(5);

    // Warned.
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatchObject({
      code: "below_statutory_minimum",
      basis: "annual",
      entitlement_days: 5,
      statutory_minimum_days: 8,
    });
    expect(body.warnings[0]!.message).toContain("warning, not a limit");
  });

  it("warns once per statutory band a policy band under-serves", async () => {
    const annual = await typeByCode("annual");
    // One flat 10-day band across all tenure: fine for under-2-years (min 8),
    // short for 2-5 years (min 12) and for 5+ (min 16).
    const { body } = await createPolicy({
      leave_type_id: annual.leave_type_id,
      name: "Flat 10 days",
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 10 }],
    });
    expect(body.warnings.map((w) => w.statutory_minimum_days).sort((a, b) => a - b)).toEqual([12, 16]);
  });

  it("does not warn on contractual terms above the minimum", async () => {
    const annual = await typeByCode("annual");
    const { status, body } = await createPolicy({
      leave_type_id: annual.leave_type_id,
      name: "Generous — 21 days for everyone",
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 21 }],
    });
    expect(status).toBe(201);
    expect(body.warnings).toEqual([]);
  });

  it("never warns for a leave type with no statutory basis", async () => {
    const compassionate = await typeByCode("compassionate");
    const { status, body } = await createPolicy({
      leave_type_id: compassionate.leave_type_id,
      name: "Compassionate — 1 day",
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 1 }],
    });
    expect(status).toBe(201);
    expect(body.warnings).toEqual([]);
  });

  it("warns on sick and maternity too, at their own minimums", async () => {
    const sick = await typeByCode("sick");
    const maternity = await typeByCode("maternity");

    const sickResult = await createPolicy({
      leave_type_id: sick.leave_type_id,
      name: "Sick — 10 days",
      bands: [{ min_months_service: 0, max_months_service: 24, entitlement_days: 10 }],
    });
    expect(sickResult.status).toBe(201);
    expect(sickResult.body.warnings[0]).toMatchObject({ basis: "sick", statutory_minimum_days: 14 });

    const maternityResult = await createPolicy({
      leave_type_id: maternity.leave_type_id,
      name: "Maternity — 60 days (pre-2022)",
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 60 }],
    });
    expect(maternityResult.status).toBe(201);
    expect(maternityResult.body.warnings[0]).toMatchObject({
      basis: "maternity",
      statutory_minimum_days: 98,
    });
  });

  it("re-evaluates the warning when bands are edited", async () => {
    const annual = await typeByCode("annual");
    const { body } = await createPolicy({
      leave_type_id: annual.leave_type_id,
      name: "Editable",
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 20 }],
    });
    expect(body.warnings).toEqual([]);

    const res = await fetchWorker(`/v1/people/leave/policies/${body.policy.policy_id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({
        bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 6 }],
      }),
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as PolicyBody;
    // Bands are replaced wholesale, and the new value stands.
    expect(patched.policy.bands).toHaveLength(1);
    expect(patched.policy.bands[0]!.entitlement_days).toBe(6);
    expect(patched.warnings.length).toBeGreaterThan(0);
  });

  it("publishes the Employment Act tables the warnings come from", async () => {
    const res = await fetchWorker("/v1/people/leave/statutory-minimums", { headers: bearer });
    const body = (await res.json()) as {
      statutory_minimums: { basis: string; bands: { days: number }[] }[];
      note: string;
    };
    const annual = body.statutory_minimums.find((m) => m.basis === "annual")!;
    expect(annual.bands.map((b) => b.days)).toEqual([8, 12, 16]);
    expect(body.statutory_minimums.find((m) => m.basis === "maternity")!.bands[0]!.days).toBe(98);
    expect(body.note).toContain("not an enforced");
  });
});

describe("policy rules", () => {
  it("keeps at most one live default policy per leave type", async () => {
    const annual = await typeByCode("annual");
    const { body } = await createPolicy({
      leave_type_id: annual.leave_type_id,
      name: "New default",
      is_default: true,
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 14 }],
    });

    const res = await fetchWorker(`/v1/people/leave/policies?leave_type_id=${annual.leave_type_id}`, {
      headers: bearer,
    });
    const { policies } = (await res.json()) as { policies: LeavePolicy[] };
    const defaults = policies.filter((p) => p.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.policy_id).toBe(body.policy.policy_id);
  });

  it("rejects a policy with no entitlement bands", async () => {
    const annual = await typeByCode("annual");
    const res = await fetchWorker("/v1/people/leave/policies", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ leave_type_id: annual.leave_type_id, name: "Empty", bands: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a policy against an unknown leave type", async () => {
    const res = await fetchWorker("/v1/people/leave/policies", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        leave_type_id: "lvt_nope",
        name: "Orphan",
        bands: [{ entitlement_days: 10 }],
      }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "invalid_leave_type" });
  });

  it("archiving a policy also stands it down as the default", async () => {
    const annual = await typeByCode("annual");
    const { body } = await createPolicy({
      leave_type_id: annual.leave_type_id,
      name: "Temporary default",
      is_default: true,
      bands: [{ entitlement_days: 14 }],
    });
    const res = await fetchWorker(`/v1/people/leave/policies/${body.policy.policy_id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ archived: true }),
    });
    const patched = (await res.json()) as PolicyBody;
    expect(patched.policy.archived_at).toBeTruthy();
    expect(patched.policy.is_default).toBe(false);
  });
});

describe("work week settings", () => {
  it("defaults to Monday-Friday and accepts a Sunday-Thursday week", async () => {
    const before = await fetchWorker("/v1/people/leave/settings", { headers: bearer });
    expect(((await before.json()) as { settings: { work_week: number[] } }).settings.work_week).toEqual([
      0, 1, 1, 1, 1, 1, 0,
    ]);

    // Kelantan / Terengganu: Sunday through Thursday.
    const res = await fetchWorker("/v1/people/leave/settings", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ work_week: [1, 1, 1, 1, 1, 0, 0] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { settings: { work_week: number[] } }).settings.work_week).toEqual([
      1, 1, 1, 1, 1, 0, 0,
    ]);
  });

  it("rejects a work week with no working days at all", async () => {
    const res = await fetchWorker("/v1/people/leave/settings", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ work_week: [0, 0, 0, 0, 0, 0, 0] }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "invalid_work_week" });
  });

  it("rejects a work week that is not seven fractions", async () => {
    const res = await fetchWorker("/v1/people/leave/settings", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ work_week: [0, 1, 1, 1, 1] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("capability gating", () => {
  it("lets an operator read and write leave configuration", async () => {
    const session = await login("op@leavepolicy.test", "operator-password");
    const read = await fetchWorker("/v1/people/leave/types", { headers: sessionHeaders(session) });
    expect(read.status).toBe(200);

    const write = await fetchWorker("/v1/people/leave/types", {
      method: "POST",
      headers: sessionHeaders(session),
      body: JSON.stringify({ code: "sabbatical", name: "Sabbatical" }),
    });
    expect(write.status).toBe(201);
  });

  it("lets readonly read but not write", async () => {
    const session = await login("ro@leavepolicy.test", "readonly-password");
    expect(
      (await fetchWorker("/v1/people/leave/types", { headers: sessionHeaders(session) })).status,
    ).toBe(200);

    const write = await fetchWorker("/v1/people/leave/types", {
      method: "POST",
      headers: sessionHeaders(session),
      body: JSON.stringify({ code: "nope", name: "Nope" }),
    });
    expect(write.status).toBe(403);
    expect((await write.json()) as { required: string }).toMatchObject({ required: "people:write" });
  });

  it("403s the employee tier on the HR surface — leave policy is not self-service", async () => {
    const session = await login("staff@leavepolicy.test", "employee-password");
    const res = await fetchWorker("/v1/people/leave/types", { headers: sessionHeaders(session) });
    expect(res.status).toBe(403);
    expect((await res.json()) as { required: string }).toMatchObject({ required: "people:read" });
  });

  it("403s finance too — leave is HR data, not finance data", async () => {
    const session = await login("fin@leavepolicy.test", "finance-password");
    expect(
      (await fetchWorker("/v1/people/leave/balances?employee_id=emp_x", {
        headers: sessionHeaders(session),
      })).status,
    ).toBe(403);
  });

  it("holds year-close to the admin bar, above the operator-level router gate", async () => {
    const operator = await login("op@leavepolicy.test", "operator-password");
    const denied = await fetchWorker("/v1/people/leave/year-close", {
      method: "POST",
      headers: sessionHeaders(operator),
      body: JSON.stringify({ leave_year: 2025, dry_run: true }),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()) as { required: string }).toMatchObject({ required: "admin:write" });

    const admin = await login("admin@leavepolicy.test", "admin-password");
    const allowed = await fetchWorker("/v1/people/leave/year-close", {
      method: "POST",
      headers: sessionHeaders(admin),
      body: JSON.stringify({ leave_year: 2025, dry_run: true }),
    });
    expect(allowed.status).toBe(200);
  });
});
