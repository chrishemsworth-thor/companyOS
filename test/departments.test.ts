import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { ROLES } from "../src/auth/roles";
import { CAPABILITY_MODULES, capabilitiesFor } from "../src/auth/capabilities";
import {
  DEPARTMENTS,
  DEPARTMENT_IDS,
  departmentsForRole,
  type Department,
} from "../src/departments/registry";

/**
 * Department registry — the org lens over the capability modules. Covers the
 * registry's own invariants, the role-scoping helper, and the machine-readable
 * GET /v1/meta/departments endpoint (full list for agents, role-filtered for
 * humans).
 */

const API_KEY = "test_api_key_departments";
const TENANT_ID = "biz_departments";
const WORKSPACE = "departments";
const ORIGIN = "http://localhost:5173";

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace: WORKSPACE, email, password }),
  });
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

async function departmentsFor(headers: Record<string, string>): Promise<Department[]> {
  const res = await fetchWorker("/v1/meta/departments", { headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { departments: Department[] };
  return body.departments;
}

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)")
    .bind(TENANT_ID, "Departments Tenant", WORKSPACE, await sha256Hex(API_KEY))
    .run();
  await createUser(env.DB, { tenant_id: TENANT_ID, email: "admin@dep.test", password: "admin-password", role: "admin" });
  await createUser(env.DB, { tenant_id: TENANT_ID, email: "fin@dep.test", password: "finance-password", role: "finance" });
  await createUser(env.DB, { tenant_id: TENANT_ID, email: "sup@dep.test", password: "support-password", role: "support" });
});

describe("registry invariants", () => {
  it("has unique department ids", () => {
    expect(new Set(DEPARTMENT_IDS).size).toBe(DEPARTMENT_IDS.length);
  });

  // Visibility is derived from the capability matrix rather than declared on
  // the department (PRD-008), so the invariant worth asserting is the reverse
  // one: every module a department surfaces must be a module roles can actually
  // be granted, or the department would be invisible to everyone.
  it("only surfaces modules the capability matrix can grant", () => {
    for (const dept of DEPARTMENTS) {
      for (const module of dept.modules) expect(CAPABILITY_MODULES).toContain(module);
    }
  });

  it("keeps every role in ROLES resolvable against the matrix", () => {
    for (const role of ROLES) expect(capabilitiesFor(role).length).toBeGreaterThan(0);
  });

  it("gives every live department at least one tool with a real route", () => {
    for (const dept of DEPARTMENTS.filter((d) => d.status === "live")) {
      expect(dept.tools.length).toBeGreaterThan(0);
      for (const tool of dept.tools) {
        expect(tool.route).toMatch(/^\//);
        expect(tool.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers all 11 departments", () => {
    expect(DEPARTMENTS).toHaveLength(11);
  });
});

describe("departmentsForRole", () => {
  it("returns everything for an agent/system caller (no role)", () => {
    expect(departmentsForRole(undefined)).toHaveLength(11);
  });

  // Finance reads CRM because you cannot invoice a customer you cannot see, so
  // Sales joins Finance + Management. It cannot write there — that is the
  // capability matrix's job, not the lens's.
  it("scopes the finance role to Finance + Sales + Management", () => {
    expect(departmentsForRole("finance").map((d) => d.id).sort()).toEqual([
      "finance",
      "management",
      "sales",
    ]);
  });

  it("scopes the support role to Customer Experience + Sales", () => {
    expect(departmentsForRole("support").map((d) => d.id).sort()).toEqual([
      "customer-experience",
      "sales",
    ]);
  });

  it("shows every department to a readonly observer", () => {
    expect(departmentsForRole("readonly")).toHaveLength(11);
  });

  it("shows the self-service tier no business departments at all", () => {
    expect(departmentsForRole("employee")).toHaveLength(0);
  });

  it("returns nothing for an unknown role rather than leaking the list", () => {
    expect(departmentsForRole("intern")).toHaveLength(0);
  });
});

describe("GET /v1/meta/departments", () => {
  it("serves the full taxonomy to an API-key (agent) caller", async () => {
    const departments = await departmentsFor({ Authorization: `Bearer ${API_KEY}` });
    expect(departments).toHaveLength(11);
    expect(departments.map((d) => d.id)).toContain("finance");
    // Every entry carries the machine-readable shape agents rely on.
    for (const dept of departments) {
      expect(typeof dept.label).toBe("string");
      expect(["live", "planned"]).toContain(dept.status);
      expect(Array.isArray(dept.modules)).toBe(true);
    }
  });

  it("filters to the caller's role for a human session", async () => {
    const fin = await departmentsFor({ Cookie: await login("fin@dep.test", "finance-password") });
    expect(fin.map((d) => d.id).sort()).toEqual(["finance", "management", "sales"]);

    const sup = await departmentsFor({ Cookie: await login("sup@dep.test", "support-password") });
    expect(sup.map((d) => d.id).sort()).toEqual(["customer-experience", "sales"]);

    const admin = await departmentsFor({ Cookie: await login("admin@dep.test", "admin-password") });
    expect(admin).toHaveLength(11);
  });

  it("requires authentication", async () => {
    expect((await fetchWorker("/v1/meta/departments")).status).toBe(401);
  });
});
