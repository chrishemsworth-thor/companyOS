import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { validatePayload } from "../src/schemas/events/registry";
import type { Employee, Team } from "../src/modules/people/types";

/**
 * People module — employee directory + teams + reporting lines. Covers CRUD via
 * the API-key (agent) path and the cookie-session path, the registry/tenant
 * validation rules SQLite can't express, manager-cycle rejection, the
 * admin+operator write gate (the first business-route role gate), and the
 * list filters that power direct-reports.
 */

const API_KEY = "test_api_key_people";
const TENANT_ID = "biz_people";
const WORKSPACE = "people-co";
const OTHER_API_KEY = "test_api_key_people_other";
const OTHER_TENANT_ID = "biz_people_other";
const ORIGIN = "http://localhost:5173";

const bearer = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

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

async function createEmployee(input: Record<string, unknown>): Promise<{ status: number; body: Employee & { error?: string; code?: string } }> {
  const res = await fetchWorker("/v1/people/employees", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as Employee & { error?: string; code?: string } };
}

async function createTeam(input: Record<string, unknown>): Promise<{ status: number; body: Team & { error?: string; code?: string } }> {
  const res = await fetchWorker("/v1/people/teams", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as Team & { error?: string; code?: string } };
}

let adminUserId: string;

beforeAll(async () => {
  for (const [tenantId, name, slug, key] of [
    [TENANT_ID, "People Tenant", WORKSPACE, API_KEY],
    [OTHER_TENANT_ID, "Other Tenant", "people-other-co", OTHER_API_KEY],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(tenantId, name, slug, await sha256Hex(key))
      .run();
  }
  const admin = await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: "admin@people.test",
    password: "admin-password",
    role: "admin",
  });
  adminUserId = admin.user_id;
  await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: "op@people.test",
    password: "operator-password",
    role: "operator",
  });
  await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: "ro@people.test",
    password: "readonly-password",
    role: "readonly",
  });
  await createUser(env.DB, {
    tenant_id: OTHER_TENANT_ID,
    email: "admin@other.test",
    password: "other-password",
    role: "admin",
  });
});

describe("teams", () => {
  it("creates, reads, and patches a team", async () => {
    const { status, body: team } = await createTeam({
      name: "Platform",
      description: "Core platform team",
      department_id: "technology",
    });
    expect(status).toBe(201);
    expect(team.team_id).toMatch(/^team_/);
    expect(team.department_id).toBe("technology");
    expect(team.lead_employee_id).toBeNull();

    const get = await fetchWorker(`/v1/people/teams/${team.team_id}`, { headers: bearer });
    expect(get.status).toBe(200);

    const emp = (await createEmployee({ name: "Lead Person", department_id: "technology" })).body;
    const patch = await fetchWorker(`/v1/people/teams/${team.team_id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ lead_employee_id: emp.employee_id }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as Team).lead_employee_id).toBe(emp.employee_id);
  });

  it("rejects a duplicate team name (409) and an unknown department (422)", async () => {
    await createTeam({ name: "Dup Squad" });
    const dup = await createTeam({ name: "Dup Squad" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("name_taken");

    const bad = await createTeam({ name: "Bad Dept Squad", department_id: "warp-drive" });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("invalid_department");
  });

  it("rejects a team lead that is not an employee of the tenant", async () => {
    const res = await createTeam({ name: "No Lead Squad", lead_employee_id: "emp_missing" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("invalid_manager");
  });
});

describe("employees", () => {
  it("creates an employee with the full profile and reads it back", async () => {
    const team = (await createTeam({ name: "Directory Team", department_id: "people" })).body;
    const { status, body: emp } = await createEmployee({
      name: "Aisyah Rahman",
      email: "aisyah@people.test",
      job_title: "HR Manager",
      department_id: "people",
      team_id: team.team_id,
      employment_type: "full_time",
      start_date: "2026-01-05",
      location: "Kuala Lumpur",
    });
    expect(status).toBe(201);
    expect(emp.employee_id).toMatch(/^emp_/);
    expect(emp.status).toBe("active");
    expect(emp.team_id).toBe(team.team_id);

    const get = await fetchWorker(`/v1/people/employees/${emp.employee_id}`, { headers: bearer });
    expect(get.status).toBe(200);
    expect(((await get.json()) as Employee).name).toBe("Aisyah Rahman");
  });

  it("accepts a planned department (HR placement is independent of module status)", async () => {
    const res = await createEmployee({ name: "Legal Eagle", department_id: "legal" });
    expect(res.status).toBe(201);
  });

  it("rejects an unknown department id", async () => {
    const res = await createEmployee({ name: "Nowhere Person", department_id: "space" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("invalid_department");
  });

  it("rejects a duplicate email within the tenant", async () => {
    await createEmployee({ name: "First", email: "same@people.test", department_id: "people" });
    const dup = await createEmployee({ name: "Second", email: "same@people.test", department_id: "people" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("email_taken");
  });

  it("rejects a team from nowhere and a manager from nowhere", async () => {
    const badTeam = await createEmployee({ name: "T", department_id: "people", team_id: "team_missing" });
    expect(badTeam.status).toBe(422);
    expect(badTeam.body.code).toBe("invalid_team");

    const badMgr = await createEmployee({ name: "M", department_id: "people", manager_employee_id: "emp_missing" });
    expect(badMgr.status).toBe(422);
    expect(badMgr.body.code).toBe("invalid_manager");
  });

  it("builds a reporting line and rejects self-management and cycles", async () => {
    const ceo = (await createEmployee({ name: "CEO", department_id: "management" })).body;
    const vp = (await createEmployee({ name: "VP", department_id: "management", manager_employee_id: ceo.employee_id })).body;
    const ic = (await createEmployee({ name: "IC", department_id: "technology", manager_employee_id: vp.employee_id })).body;

    // Self-management.
    const self = await fetchWorker(`/v1/people/employees/${ceo.employee_id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ manager_employee_id: ceo.employee_id }),
    });
    expect(self.status).toBe(422);
    expect(((await self.json()) as { code: string }).code).toBe("invalid_manager");

    // CEO → VP → IC, now try CEO reports to IC: closes a loop.
    const cycle = await fetchWorker(`/v1/people/employees/${ceo.employee_id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ manager_employee_id: ic.employee_id }),
    });
    expect(cycle.status).toBe(422);
    expect(((await cycle.json()) as { code: string }).code).toBe("manager_cycle");

    // Direct reports via the manager filter.
    const reports = await fetchWorker(`/v1/people/employees?manager_id=${ceo.employee_id}`, { headers: bearer });
    const { employees } = (await reports.json()) as { employees: Employee[] };
    expect(employees.map((e) => e.employee_id)).toEqual([vp.employee_id]);
  });

  it("links an employee to a login user once, same tenant only", async () => {
    const linked = await createEmployee({
      name: "Admin Person",
      department_id: "management",
      user_id: adminUserId,
    });
    expect(linked.status).toBe(201);

    const double = await createEmployee({ name: "Imposter", department_id: "management", user_id: adminUserId });
    expect(double.status).toBe(409);
    expect(double.body.code).toBe("user_already_linked");

    const otherUser = await env.DB.prepare("SELECT user_id FROM users WHERE tenant_id = ?")
      .bind(OTHER_TENANT_ID)
      .first<{ user_id: string }>();
    const cross = await createEmployee({
      name: "Cross Tenant",
      department_id: "management",
      user_id: otherUser!.user_id,
    });
    expect(cross.status).toBe(422);
    expect(cross.body.code).toBe("user_not_found");
  });

  it("stays tenant-scoped: another tenant sees nothing", async () => {
    await createEmployee({ name: "Ours Only", department_id: "people" });
    const res = await fetchWorker("/v1/people/employees", {
      headers: { Authorization: `Bearer ${OTHER_API_KEY}` },
    });
    const { employees } = (await res.json()) as { employees: Employee[] };
    expect(employees).toHaveLength(0);
  });

  it("filters and paginates the directory", async () => {
    const team = (await createTeam({ name: "Filter Team" })).body;
    await createEmployee({ name: "F1", department_id: "finance", team_id: team.team_id });
    await createEmployee({ name: "F2", department_id: "finance", team_id: team.team_id, status: "inactive" });

    const byTeam = await fetchWorker(`/v1/people/employees?team_id=${team.team_id}`, { headers: bearer });
    expect(((await byTeam.json()) as { employees: Employee[] }).employees).toHaveLength(2);

    const active = await fetchWorker(`/v1/people/employees?team_id=${team.team_id}&status=active`, { headers: bearer });
    expect(((await active.json()) as { employees: Employee[] }).employees.map((e) => e.name)).toEqual(["F1"]);

    const page1 = await fetchWorker(`/v1/people/employees?team_id=${team.team_id}&limit=1`, { headers: bearer });
    const p1 = (await page1.json()) as { employees: Employee[]; next_cursor: string | null };
    expect(p1.employees).toHaveLength(1);
    expect(p1.next_cursor).toBe(p1.employees[0]!.employee_id);
    const page2 = await fetchWorker(
      `/v1/people/employees?team_id=${team.team_id}&limit=1&cursor=${p1.next_cursor}`,
      { headers: bearer },
    );
    const p2 = (await page2.json()) as { employees: Employee[]; next_cursor: string | null };
    expect(p2.employees).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
  });
});

describe("role gating (first business-route write gate)", () => {
  it("lets readonly read but not write; operator writes; admin writes", async () => {
    const ro = await login("ro@people.test", "readonly-password");
    const roHeaders = { Cookie: ro.cookie, "X-CSRF-Token": ro.csrf, "Content-Type": "application/json", Origin: ORIGIN };

    const read = await fetchWorker("/v1/people/employees", { headers: { Cookie: ro.cookie } });
    expect(read.status).toBe(200);

    const write = await fetchWorker("/v1/people/employees", {
      method: "POST",
      headers: roHeaders,
      body: JSON.stringify({ name: "Should Fail", department_id: "people" }),
    });
    expect(write.status).toBe(403);

    for (const [email, password] of [
      ["op@people.test", "operator-password"],
      ["admin@people.test", "admin-password"],
    ] as const) {
      const session = await login(email, password);
      const res = await fetchWorker("/v1/people/employees", {
        method: "POST",
        headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ name: `Created by ${email}`, department_id: "people" }),
      });
      expect(res.status).toBe(201);
    }
  });
});

describe("events", () => {
  it("emits registry-valid payloads for employee and team events", () => {
    expect(
      validatePayload("employee.created", {
        employee_id: "emp_x",
        name: "N",
        department_id: "people",
        team_id: "team_x",
      }),
    ).toEqual({ ok: true });
    expect(validatePayload("employee.updated", { employee_id: "emp_x", changed: ["team_id"] })).toEqual({ ok: true });
    expect(validatePayload("team.created", { team_id: "team_x", name: "T" })).toEqual({ ok: true });
  });
});
