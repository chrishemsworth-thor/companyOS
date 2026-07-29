import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker, { app, V1_MOUNTS } from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { ROLES, type Role } from "../src/auth/roles";
import {
  CAPABILITY_MODULES,
  can,
  capabilitiesFor,
  type Capability,
} from "../src/auth/capabilities";

/**
 * Roles & permissions (PRD-008). The point of this file is the **negative**
 * path: proving that a role which should not be able to do something gets a 403,
 * per module, rather than trusting that the gate is wired up.
 *
 * Three layers are covered:
 *   1. the matrix itself (`src/auth/capabilities.ts`) as pure data;
 *   2. mount-table coverage — no /v1 route escapes a capability gate;
 *   3. live requests per role and module through the real Worker.
 */

const API_KEY = "test_api_key_caps";
const TENANT_ID = "biz_caps";
const WORKSPACE = "caps-co";
const ORIGIN = "http://localhost:5173";
const PASSWORD = "capability-password";

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface Session {
  cookie: string;
  csrf: string;
}

const sessions = new Map<Role, Session>();
/** usr_ ids per role, for linking employee records and asserting revocation. */
const userIds = new Map<Role, string>();

async function login(email: string): Promise<Session> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace: WORKSPACE, email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { csrf_token: string };
  return { cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "", csrf: body.csrf_token };
}

/** Request as a human role: cookie session + CSRF on writes. */
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

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(TENANT_ID, "Capabilities Tenant", WORKSPACE, await sha256Hex(API_KEY))
    .run();

  for (const role of ROLES) {
    const user = await createUser(env.DB, {
      tenant_id: TENANT_ID,
      email: `${role}@caps.test`,
      password: PASSWORD,
      role,
    });
    userIds.set(role, user.user_id);
    sessions.set(role, await login(user.email));
  }
});

// ---------------------------------------------------------------------------
// 1. The matrix as data — the documented role → capability mapping.
// ---------------------------------------------------------------------------

describe("capability matrix", () => {
  const BUSINESS_READS: Capability[] = [
    "finance:read",
    "crm:read",
    "support:read",
    "build:read",
    "insights:read",
    "people:read",
  ];

  it("grants admin every capability", () => {
    for (const module of CAPABILITY_MODULES) {
      expect(can("admin", `${module}:read`)).toBe(true);
      expect(can("admin", `${module}:write`)).toBe(true);
    }
  });

  it("gives readonly every business read and no write at all", () => {
    for (const capability of BUSINESS_READS) expect(can("readonly", capability)).toBe(true);
    for (const module of CAPABILITY_MODULES) {
      // `self` is the identity axis, not business data: an observer who is also
      // staff still acts on their own records (PRD-006's leave request).
      if (module === "self") continue;
      expect(can("readonly", `${module}:write`)).toBe(false);
    }
  });

  it("gives the employee tier self and meta only", () => {
    expect(capabilitiesFor("employee")).toEqual(["meta:read", "self:read", "self:write"]);
    for (const capability of BUSINESS_READS) expect(can("employee", capability)).toBe(false);
  });

  it("keeps admin surfaces to admin — no silent escalation for any other role", () => {
    for (const role of ROLES.filter((r) => r !== "admin")) {
      expect(can(role, "admin:read")).toBe(false);
      expect(can(role, "admin:write")).toBe(false);
    }
  });

  it("scopes finance and support to their own module, reading CRM but not writing it", () => {
    expect(can("finance", "finance:write")).toBe(true);
    expect(can("finance", "crm:read")).toBe(true);
    expect(can("finance", "crm:write")).toBe(false);
    expect(can("finance", "people:read")).toBe(false);

    expect(can("support", "support:write")).toBe(true);
    expect(can("support", "crm:read")).toBe(true);
    expect(can("support", "crm:write")).toBe(false);
    expect(can("support", "finance:read")).toBe(false);
  });

  it("gives every role the self axis", () => {
    for (const role of ROLES) expect(can(role, "self:read")).toBe(true);
  });

  it("fails closed for an absent or unknown role", () => {
    expect(can(undefined, "meta:read")).toBe(false);
    // A session minted before a role was removed from ROLES must not be
    // treated as privileged.
    expect(can("superuser", "finance:read")).toBe(false);
    expect(capabilitiesFor("superuser")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Mount coverage — "this route is unprotected" must be impossible.
// ---------------------------------------------------------------------------

describe("mount table coverage", () => {
  /** Concrete registered paths under /v1 (middleware wildcards excluded). */
  const v1Paths = [
    ...new Set(
      app.routes
        .map((r) => r.path)
        .filter((p) => p.startsWith("/v1/") && !p.endsWith("*")),
    ),
  ];

  it("finds registered /v1 routes to check", () => {
    expect(v1Paths.length).toBeGreaterThan(40);
  });

  it("gates every /v1 route with a capability module", () => {
    const unguarded = v1Paths.filter((path) => {
      // /v1/auth is the pre-authentication login surface by design: it is
      // mounted before authenticate() and has no actor to check.
      if (path.startsWith("/v1/auth")) return false;
      return !V1_MOUNTS.some(([mount]) => path === mount || path.startsWith(`${mount}/`));
    });
    expect(unguarded).toEqual([]);
  });

  it("declares a module for every mount, with no duplicate paths", () => {
    const paths = V1_MOUNTS.map(([path]) => path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const [, module] of V1_MOUNTS) expect(CAPABILITY_MODULES).toContain(module);
  });
});

// ---------------------------------------------------------------------------
// 3. Live enforcement, per module, through the real Worker.
// ---------------------------------------------------------------------------

/**
 * One representative read and write per capability module. `allowedWrite` /
 * `allowedRead` are the roles the matrix says should get through; every other
 * role must see a 403. Denials are asserted exactly; permitted calls are
 * asserted as "not 403", since a valid-but-incomplete body may 400/422 — the
 * gate, not the handler, is what this table is testing.
 */
const MODULE_SURFACES: Array<{
  module: string;
  read: string;
  write?: { path: string; method?: string; body?: unknown };
  allowedRead: Role[];
  allowedWrite: Role[];
}> = [
  {
    module: "finance",
    read: "/v1/invoices",
    write: { path: "/v1/invoices", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "finance", "readonly"],
    allowedWrite: ["admin", "operator", "finance"],
  },
  {
    module: "finance (ledger)",
    read: "/v1/ledger/accounts",
    write: { path: "/v1/ledger/entries", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "finance", "readonly"],
    allowedWrite: ["admin", "operator", "finance"],
  },
  {
    module: "finance (payments)",
    read: "/v1/ledger/entries",
    write: { path: "/v1/payments", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "finance", "readonly"],
    allowedWrite: ["admin", "operator", "finance"],
  },
  {
    module: "crm (customers)",
    read: "/v1/customers",
    write: { path: "/v1/customers", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "finance", "support", "readonly"],
    allowedWrite: ["admin", "operator"],
  },
  {
    module: "crm (deals)",
    read: "/v1/deals",
    write: { path: "/v1/deals", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "finance", "support", "readonly"],
    allowedWrite: ["admin", "operator"],
  },
  {
    module: "crm (leads)",
    read: "/v1/leads",
    write: { path: "/v1/leads", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "finance", "support", "readonly"],
    allowedWrite: ["admin", "operator"],
  },
  {
    module: "crm (quotes)",
    read: "/v1/quotes",
    write: { path: "/v1/quotes", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "finance", "support", "readonly"],
    allowedWrite: ["admin", "operator"],
  },
  {
    module: "crm (activities)",
    read: "/v1/customers",
    write: { path: "/v1/activities", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "finance", "support", "readonly"],
    allowedWrite: ["admin", "operator"],
  },
  {
    module: "support",
    read: "/v1/tickets",
    write: { path: "/v1/tickets", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "support", "readonly"],
    allowedWrite: ["admin", "operator", "support"],
  },
  {
    module: "build (projects)",
    read: "/v1/projects",
    write: { path: "/v1/projects", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "readonly"],
    allowedWrite: ["admin", "operator"],
  },
  {
    module: "build (issues)",
    read: "/v1/issues",
    write: { path: "/v1/issues", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "readonly"],
    allowedWrite: ["admin", "operator"],
  },
  {
    module: "insights",
    read: "/v1/insights/summary",
    allowedRead: ["admin", "operator", "finance", "readonly"],
    allowedWrite: [],
  },
  {
    module: "people",
    read: "/v1/people/employees",
    write: { path: "/v1/people/employees", method: "POST", body: {} },
    allowedRead: ["admin", "operator", "readonly"],
    allowedWrite: ["admin", "operator"],
  },
  {
    module: "agents (event log)",
    read: "/v1/events",
    allowedRead: ["admin", "operator", "readonly"],
    allowedWrite: [],
  },
  {
    module: "files",
    read: "/v1/files/file_missing",
    write: { path: "/v1/files", method: "POST" },
    allowedRead: ["admin", "operator", "finance", "support", "readonly"],
    allowedWrite: ["admin", "operator", "finance"],
  },
  {
    module: "settings",
    read: "/v1/settings/company-profile",
    write: { path: "/v1/settings/company-profile", method: "PUT", body: {} },
    allowedRead: ["admin", "operator", "finance", "support", "readonly"],
    allowedWrite: ["admin", "operator"],
  },
  {
    module: "admin (users)",
    read: "/v1/users",
    write: { path: "/v1/users", method: "POST", body: {} },
    allowedRead: ["admin"],
    allowedWrite: ["admin"],
  },
  {
    module: "admin (webhook sources)",
    read: "/v1/webhook-sources",
    write: { path: "/v1/webhook-sources", method: "POST", body: {} },
    allowedRead: ["admin"],
    allowedWrite: ["admin"],
  },
  {
    module: "admin (google accounts)",
    read: "/v1/google-accounts",
    write: { path: "/v1/google-accounts/connect", method: "POST", body: {} },
    allowedRead: ["admin"],
    allowedWrite: ["admin"],
  },
  {
    module: "meta",
    read: "/v1/meta/departments",
    allowedRead: [...ROLES],
    allowedWrite: [],
  },
];

describe("per-module enforcement", () => {
  for (const surface of MODULE_SURFACES) {
    describe(surface.module, () => {
      for (const role of ROLES) {
        const mayRead = surface.allowedRead.includes(role);
        it(`${role} ${mayRead ? "reads" : "is refused a read"}`, async () => {
          const res = await asRole(role, surface.read);
          if (mayRead) expect(res.status).not.toBe(403);
          else expect(res.status).toBe(403);
        });
      }

      const write = surface.write;
      if (!write) return;
      for (const role of ROLES) {
        const mayWrite = surface.allowedWrite.includes(role);
        it(`${role} ${mayWrite ? "may write" : "is refused a write"}`, async () => {
          const res = await asRole(role, write.path, write.method ?? "POST", write.body);
          if (mayWrite) expect(res.status).not.toBe(403);
          else expect(res.status).toBe(403);
        });
      }
    });
  }

  it("names the missing capability in the 403 body", async () => {
    const res = await asRole("readonly", "/v1/invoices", "POST", {});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden", required: "finance:write" });
  });

  it("refuses a readonly write before the handler runs (no partial effect)", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?",
    )
      .bind(TENANT_ID)
      .first<{ n: number }>();
    const res = await asRole("readonly", "/v1/customers", "POST", {
      name: "Should Not Exist",
      email: "nope@caps.test",
    });
    expect(res.status).toBe(403);
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?",
    )
      .bind(TENANT_ID)
      .first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });
});

describe("system (tenant API key) callers", () => {
  const bearer = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

  it("bypasses the matrix on reads that no single role could make together", async () => {
    for (const path of ["/v1/users", "/v1/invoices", "/v1/people/employees", "/v1/tickets"]) {
      expect((await fetchWorker(path, { headers: bearer })).status).toBe(200);
    }
  });

  it("bypasses the matrix on writes", async () => {
    const res = await fetchWorker("/v1/customers", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Agent Made This" }),
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// The self-service tier: its own record, and nothing else.
// ---------------------------------------------------------------------------

describe("self-service (GET /v1/me/employee)", () => {
  beforeAll(async () => {
    // An employee record linked to the `employee` login, with HR notes on it.
    await env.DB.prepare(
      `INSERT INTO employees (employee_id, tenant_id, name, email, job_title, department_id,
                              user_id, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
      .bind(
        "emp_self_caps",
        TENANT_ID,
        "Selma Self",
        "selma@caps.test",
        "Analyst",
        "people",
        userIds.get("employee")!,
        "HR only: flight risk",
      )
      .run();
  });

  it("returns the employee's own record", async () => {
    const res = await asRole("employee", "/v1/me/employee");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { employee: { name: string; job_title: string } };
    expect(body.employee).toMatchObject({ name: "Selma Self", job_title: "Analyst" });
  });

  it("withholds HR notes from the self view", async () => {
    const res = await asRole("employee", "/v1/me/employee");
    const body = (await res.json()) as { employee: Record<string, unknown> };
    expect(body.employee).not.toHaveProperty("notes");
  });

  it("still refuses the employee the People directory the record lives in", async () => {
    expect((await asRole("employee", "/v1/people/employees")).status).toBe(403);
    expect((await asRole("employee", "/v1/people/employees/emp_self_caps")).status).toBe(403);
  });

  it("404s a login with no linked employee record", async () => {
    expect((await asRole("admin", "/v1/me/employee")).status).toBe(404);
  });

  it("400s an API-key caller, which has no self to resolve", async () => {
    const res = await fetchWorker("/v1/me/employee", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "not_a_user" });
  });
});

// ---------------------------------------------------------------------------
// A role only means something if changing it takes effect.
// ---------------------------------------------------------------------------

describe("role changes and live sessions", () => {
  it("revokes sessions on demotion, so the old role stops working immediately", async () => {
    const victim = await createUser(env.DB, {
      tenant_id: TENANT_ID,
      email: "demote-me@caps.test",
      password: PASSWORD,
      role: "operator",
    });
    const session = await login(victim.email);
    const asVictim = (method = "GET", body?: unknown) =>
      fetchWorker("/v1/customers", {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: session.cookie,
          "X-CSRF-Token": session.csrf,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    expect((await asVictim("POST", { name: "While Operator" })).status).toBe(201);

    const patched = await asRole("admin", `/v1/users/${victim.user_id}`, "PATCH", {
      role: "readonly",
    });
    expect(patched.status).toBe(200);

    // The session carried role=operator; it must no longer be usable at all.
    expect((await asVictim("POST", { name: "After Demotion" })).status).toBe(401);
  });

  it("revokes sessions when a login is disabled", async () => {
    const victim = await createUser(env.DB, {
      tenant_id: TENANT_ID,
      email: "disable-me@caps.test",
      password: PASSWORD,
      role: "operator",
    });
    const session = await login(victim.email);
    expect(
      (await fetchWorker("/v1/customers", { headers: { Cookie: session.cookie } })).status,
    ).toBe(200);

    await asRole("admin", `/v1/users/${victim.user_id}`, "PATCH", { status: "disabled" });

    expect(
      (await fetchWorker("/v1/customers", { headers: { Cookie: session.cookie } })).status,
    ).toBe(401);
  });
});

describe("GET /v1/auth/me", () => {
  it("serves the caller's capabilities so the console can hide dead actions", async () => {
    const res = await fetchWorker("/v1/auth/me", {
      headers: { Cookie: sessions.get("support")!.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: Capability[] };
    expect(body.capabilities).toContain("support:write");
    expect(body.capabilities).toContain("crm:read");
    expect(body.capabilities).not.toContain("crm:write");
    expect(body.capabilities).not.toContain("finance:read");
  });
});
