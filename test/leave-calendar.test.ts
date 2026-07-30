import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { ensureEventBus } from "../src/queue/direct";
import { decide } from "../src/modules/approvals/service";
import {
  findTeamOverlaps,
  previewLeaveRequest,
  submitLeaveRequest,
} from "../src/modules/people/leave/service";
import type { Employee } from "../src/modules/people/types";

/**
 * PRD-006c — the team calendar and the overlap warning.
 *
 * PRD-006 calls the calendar "the feature managers actually use" and states the
 * overlap rule twice, in two different directions:
 *
 *  - another team member's approved leave → **warn, do not block**;
 *  - the same employee's own existing request → **409** (covered in
 *    test/leave-requests.test.ts).
 *
 * This file covers the warning half, the calendar read, and the visibility rules
 * on both — because a calendar that leaks the whole company's absences to a
 * self-service login would be a worse bug than one that shows too little.
 *
 * Isolated-storage note: shared fixtures are seeded in `beforeAll`; approved
 * leave that a test needs to exist is created inside that test.
 */

const WORKSPACE = "leave-cal-co";
const TENANT_ID = "biz_leave_cal";
const API_KEY = "test_api_key_leave_cal";
const ORIGIN = "http://localhost:5173";

const YEAR = 2027;
const MON = `${YEAR}-03-01`;
const TUE = `${YEAR}-03-02`;
const WED = `${YEAR}-03-03`;
const THU = `${YEAR}-03-04`;
const FRI = `${YEAR}-03-05`;
const MONTH_START = `${YEAR}-03-01`;
const MONTH_END = `${YEAR}-03-31`;
/** A different month, to prove the window actually filters. */
const APRIL_START = `${YEAR}-04-01`;
const APRIL_END = `${YEAR}-04-30`;

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

async function login(email: string, password: string): Promise<Session> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace: WORKSPACE, email, password }),
  });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const body = (await res.json()) as { csrf_token: string };
  return { cookie, csrf: body.csrf_token };
}

function sessionHeaders(s: Session): Record<string, string> {
  return {
    Cookie: s.cookie,
    "X-CSRF-Token": s.csrf,
    "Content-Type": "application/json",
    Origin: ORIGIN,
  };
}

/** The free-plan inline bus, so a decision actually transitions the request. */
function inlineEnv(): Env {
  const stripped = { ...(env as unknown as Env) } as Record<string, unknown>;
  delete stripped.EVENTS;
  return ensureEventBus(stripped as unknown as Env);
}

type UserKey = "admin" | "alice" | "bob" | "carol" | "dave" | "hr";
const user = {} as Record<UserKey, string>;

/** Team Delivery: alice, bob (peers), managed by carol. */
const EMP_ALICE = "emp_lvc_alice";
const EMP_BOB = "emp_lvc_bob";
const EMP_CAROL = "emp_lvc_carol";
/** Team Finance: dave. Not a peer of anybody in Delivery. */
const EMP_DAVE = "emp_lvc_dave";
const EMP_HR = "emp_lvc_hr";
/** No team at all, but reports to carol — the same-manager peer path. */
const EMP_EVE = "emp_lvc_eve";

const TEAM_DELIVERY = "team_lvc_delivery";
const TEAM_FINANCE = "team_lvc_finance";

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(TENANT_ID, "Leave Calendar Tenant", WORKSPACE, await sha256Hex(API_KEY))
    .run();

  const seeded: ReadonlyArray<[UserKey, string, string, Parameters<typeof createUser>[1]["role"]]> = [
    ["admin", "admin@leave-cal.test", "admin-password", "admin"],
    ["alice", "alice@leave-cal.test", "alice-password", "employee"],
    ["bob", "bob@leave-cal.test", "bob-password", "employee"],
    ["carol", "carol@leave-cal.test", "carol-password", "employee"],
    ["dave", "dave@leave-cal.test", "dave-password", "employee"],
    // `operator` holds people:read — the HR/manager view of the calendar.
    ["hr", "hr@leave-cal.test", "hr-password", "operator"],
  ];
  for (const [key, email, password, role] of seeded) {
    const created = await createUser(env.DB, {
      tenant_id: TENANT_ID,
      email,
      password,
      display_name: key,
      role,
    });
    user[key] = created.user_id;
  }

  for (const [teamId, name] of [
    [TEAM_DELIVERY, "Delivery"],
    [TEAM_FINANCE, "Finance"],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO teams (team_id, tenant_id, name, department_id) VALUES (?, ?, ?, ?)",
    )
      .bind(teamId, TENANT_ID, name, "operations")
      .run();
  }

  // Manager first (FK on (tenant_id, manager_employee_id)).
  for (const [id, name, login, team] of [
    [EMP_CAROL, "Carol Manager", "carol", TEAM_DELIVERY],
    [EMP_ALICE, "Alice Dev", "alice", TEAM_DELIVERY],
    [EMP_BOB, "Bob Dev", "bob", TEAM_DELIVERY],
    [EMP_DAVE, "Dave Finance", "dave", TEAM_FINANCE],
    [EMP_HR, "HR Person", "hr", null],
    [EMP_EVE, "Eve NoTeam", null, null],
  ] as const) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO employees
         (employee_id, tenant_id, name, department_id, user_id, team_id, start_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        TENANT_ID,
        name,
        "operations",
        login ? user[login as UserKey] : null,
        team,
        `${YEAR - 3}-01-01`,
      )
      .run();
  }
  for (const id of [EMP_ALICE, EMP_BOB, EMP_EVE]) {
    await env.DB.prepare(
      "UPDATE employees SET manager_employee_id = ? WHERE tenant_id = ? AND employee_id = ?",
    )
      .bind(EMP_CAROL, TENANT_ID, id)
      .run();
  }
});

async function employee(employeeId: string): Promise<Employee> {
  return (await env.DB.prepare("SELECT * FROM employees WHERE tenant_id = ? AND employee_id = ?")
    .bind(TENANT_ID, employeeId)
    .first<Employee>())!;
}

/**
 * File leave and get it approved through the real decision path, so it lands on
 * the calendar the way production leave does.
 */
async function approvedLeave(
  employeeId: string,
  requesterUserId: string | null,
  start: string,
  end: string,
  leaveTypeCode = "annual",
) {
  const inline = inlineEnv();
  const request = await submitLeaveRequest(inline, TENANT_ID, {
    employee_id: employeeId,
    leave_type_code: leaveTypeCode,
    start_date: start,
    end_date: end,
    requested_by: requesterUserId,
  });
  const approval = await env.DB.prepare(
    "SELECT approver_user_id FROM approvals WHERE tenant_id = ? AND approval_id = ?",
  )
    .bind(TENANT_ID, request.approval_id)
    .first<{ approver_user_id: string }>();

  await decide(inline, TENANT_ID, request.approval_id!, {
    actor_user_id: approval!.approver_user_id,
    // Whoever resolution picked; `admin` covers the case where it fell back to
    // the tenant admin and the requester is the same person.
    actor_role: "admin",
    decision: "approved",
  });
  return request;
}

/* ---------------------------------------------- the overlap WARNING (not 409) */

describe("acceptance: overlapping a teammate's approved leave warns without blocking", () => {
  it("warns and still submits", async () => {
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);

    const inline = inlineEnv();
    const preview = await previewLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_ALICE,
      leave_type_code: "annual",
      start_date: WED,
      end_date: FRI,
    });

    // A warning, and crucially NOT a blocker.
    expect(preview.warnings.map((w) => w.code)).toContain("team_overlap");
    expect(preview.blockers).toEqual([]);
    expect(preview.team_overlaps).toHaveLength(1);
    expect(preview.team_overlaps[0]).toMatchObject({
      employee_id: EMP_BOB,
      employee_name: "Bob Dev",
      state: "approved",
    });

    // And the request goes through, because PRD-006 says warn, do not block.
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_ALICE,
      leave_type_code: "annual",
      start_date: WED,
      end_date: FRI,
      requested_by: user.alice,
    });
    expect(request.state).toBe("pending");
  });

  it("names the teammate in the warning message when there is exactly one", async () => {
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    const preview = await previewLeaveRequest(inlineEnv(), TENANT_ID, {
      employee_id: EMP_ALICE,
      leave_type_code: "annual",
      start_date: WED,
      end_date: WED,
    });
    expect(preview.warnings.find((w) => w.code === "team_overlap")!.message).toContain("Bob Dev");
  });

  it("does not warn about somebody on another team", async () => {
    await approvedLeave(EMP_DAVE, user.dave, TUE, THU);
    const preview = await previewLeaveRequest(inlineEnv(), TENANT_ID, {
      employee_id: EMP_ALICE,
      leave_type_code: "annual",
      start_date: WED,
      end_date: FRI,
    });
    expect(preview.team_overlaps).toEqual([]);
    expect(preview.warnings.map((w) => w.code)).not.toContain("team_overlap");
  });

  it("does not warn about a teammate's still-PENDING leave", async () => {
    // A request that may yet be refused is not a coverage problem.
    const inline = inlineEnv();
    await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_BOB,
      leave_type_code: "annual",
      start_date: TUE,
      end_date: THU,
      requested_by: user.bob,
    });
    const preview = await previewLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_ALICE,
      leave_type_code: "annual",
      start_date: WED,
      end_date: FRI,
    });
    expect(preview.team_overlaps).toEqual([]);
  });

  it("warns via the same-manager path for an employee with no team", async () => {
    // `employees.team_id` is nullable and plenty of small tenants never create
    // teams. Falling back to the reporting line is what keeps the headline
    // feature working for exactly those companies.
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    const overlaps = await findTeamOverlaps(
      env.DB,
      TENANT_ID,
      await employee(EMP_EVE),
      WED,
      FRI,
    );
    expect(overlaps.map((o) => o.employee_id)).toContain(EMP_BOB);
  });

  it("never reports the employee's own leave as a team overlap", async () => {
    await approvedLeave(EMP_ALICE, user.alice, TUE, THU);
    const overlaps = await findTeamOverlaps(
      env.DB,
      TENANT_ID,
      await employee(EMP_ALICE),
      TUE,
      THU,
    );
    expect(overlaps.every((o) => o.employee_id !== EMP_ALICE)).toBe(true);
  });
});

/* ------------------------------------------------------------ the calendar */

describe("team calendar (who is off, by team and by month)", () => {
  it("returns approved leave in the requested window", async () => {
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: sessionHeaders(hr),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from: string;
      to: string;
      items: Array<{ employee_id: string; employee_name: string; state: string }>;
    };
    expect(body).toMatchObject({ from: MONTH_START, to: MONTH_END });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      employee_id: EMP_BOB,
      employee_name: "Bob Dev",
      state: "approved",
    });
  });

  it("excludes leave outside the window", async () => {
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${APRIL_START}&to=${APRIL_END}`, {
      headers: sessionHeaders(hr),
    });
    expect((await res.json()) as { items: unknown[] }).toMatchObject({ items: [] });
  });

  it("includes leave that straddles the window boundary", async () => {
    // A request from late February into March belongs on March's calendar. This
    // is why the filter is an overlap test, not a containment one.
    await approvedLeave(EMP_BOB, user.bob, `${YEAR}-02-25`, `${YEAR}-03-03`);
    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: sessionHeaders(hr),
    });
    const body = (await res.json()) as { items: Array<{ employee_id: string }> };
    expect(body.items.map((i) => i.employee_id)).toContain(EMP_BOB);
  });

  it("excludes pending leave — the calendar answers 'who will be absent'", async () => {
    const inline = inlineEnv();
    await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_BOB,
      leave_type_code: "annual",
      start_date: TUE,
      end_date: THU,
      requested_by: user.bob,
    });
    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: sessionHeaders(hr),
    });
    expect((await res.json()) as { items: unknown[] }).toMatchObject({ items: [] });
  });

  it("still shows leave whose cancellation is awaiting re-approval", async () => {
    // Booked until somebody agrees to hand it back, so a manager planning cover
    // must still see it.
    const request = await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    await env.DB.prepare(
      `UPDATE leave_requests SET state = 'cancellation_pending'
        WHERE tenant_id = ? AND leave_request_id = ?`,
    )
      .bind(TENANT_ID, request.leave_request_id)
      .run();

    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: sessionHeaders(hr),
    });
    const body = (await res.json()) as { items: Array<{ state: string }> };
    expect(body.items.map((i) => i.state)).toEqual(["cancellation_pending"]);
  });

  it("drops cancelled leave off the calendar entirely", async () => {
    const request = await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    await env.DB.prepare(
      "UPDATE leave_requests SET state = 'cancelled' WHERE tenant_id = ? AND leave_request_id = ?",
    )
      .bind(TENANT_ID, request.leave_request_id)
      .run();

    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: sessionHeaders(hr),
    });
    expect((await res.json()) as { items: unknown[] }).toMatchObject({ items: [] });
  });

  it("filters by team for a people:read holder", async () => {
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    await approvedLeave(EMP_DAVE, user.dave, TUE, THU);

    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(
      `/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}&team_id=${TEAM_FINANCE}`,
      { headers: sessionHeaders(hr) },
    );
    const body = (await res.json()) as { items: Array<{ employee_id: string }> };
    expect(body.items.map((i) => i.employee_id)).toEqual([EMP_DAVE]);
  });

  it("400s when from is after to", async () => {
    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_END}&to=${MONTH_START}`, {
      headers: sessionHeaders(hr),
    });
    expect(res.status).toBe(400);
  });

  it("400s an unparseable date", async () => {
    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${YEAR}-02-30&to=${MONTH_END}`, {
      headers: sessionHeaders(hr),
    });
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------ calendar visibility */

describe("calendar visibility", () => {
  it("shows a self-service login their own team only", async () => {
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    await approvedLeave(EMP_DAVE, user.dave, TUE, THU);

    // Alice holds `employee` — no people:read at all — so she gets Delivery and
    // not Finance. This is the case that matters: a leave calendar leaking the
    // whole company's absences to any login would be worse than one showing too
    // little.
    const alice = await login("alice@leave-cal.test", "alice-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: sessionHeaders(alice),
    });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { items: Array<{ employee_id: string }> }).items.map(
      (i) => i.employee_id,
    );
    expect(ids).toContain(EMP_BOB);
    expect(ids).not.toContain(EMP_DAVE);
  });

  it("shows a manager their direct reports", async () => {
    await approvedLeave(EMP_ALICE, user.alice, TUE, THU);
    const carol = await login("carol@leave-cal.test", "carol-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: sessionHeaders(carol),
    });
    const ids = ((await res.json()) as { items: Array<{ employee_id: string }> }).items.map(
      (i) => i.employee_id,
    );
    expect(ids).toContain(EMP_ALICE);
  });

  it("403s a team filter from a login without people:read", async () => {
    const alice = await login("alice@leave-cal.test", "alice-password");
    const res = await fetchWorker(
      `/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}&team_id=${TEAM_FINANCE}`,
      { headers: sessionHeaders(alice) },
    );
    expect(res.status).toBe(403);
  });

  it("403s an employee filter from a login without people:read", async () => {
    const alice = await login("alice@leave-cal.test", "alice-password");
    const res = await fetchWorker(
      `/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}&employee_id=${EMP_DAVE}`,
      { headers: sessionHeaders(alice) },
    );
    expect(res.status).toBe(403);
  });

  it("shows a people:read holder the whole company by default", async () => {
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    await approvedLeave(EMP_DAVE, user.dave, TUE, THU);
    const hr = await login("hr@leave-cal.test", "hr-password");
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: sessionHeaders(hr),
    });
    const ids = ((await res.json()) as { items: Array<{ employee_id: string }> }).items.map(
      (i) => i.employee_id,
    );
    expect(ids).toContain(EMP_BOB);
    expect(ids).toContain(EMP_DAVE);
  });

  it("serves a programmatic caller the whole company", async () => {
    // A tenant API key is a trusted root credential for agents and bypasses the
    // capability matrix, as it does everywhere else under /v1.
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it("does not leak another tenant's leave", async () => {
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    const otherTenant = "biz_leave_cal_other";
    const otherKey = "test_api_key_leave_cal_other";
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(otherTenant, "Other", "leave-cal-other-co", await sha256Hex(otherKey))
      .run();

    const res = await fetchWorker(`/v1/leave/calendar?from=${MONTH_START}&to=${MONTH_END}`, {
      headers: { Authorization: `Bearer ${otherKey}` },
    });
    expect((await res.json()) as { items: unknown[] }).toMatchObject({ items: [] });
  });
});

/* ------------------------------------------------------ the card's overlaps */

describe("the approval card's overlapping-team-leave field", () => {
  it("carries the teammate's approved leave on GET /v1/leave/requests/:id", async () => {
    // PRD-006c names "overlapping team leave" as a card field, and the manager's
    // real question at the moment of deciding is whether anyone is left covering.
    await approvedLeave(EMP_BOB, user.bob, TUE, THU);
    const inline = inlineEnv();
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_ALICE,
      leave_type_code: "annual",
      start_date: WED,
      end_date: FRI,
      requested_by: user.alice,
    });

    const carol = await login("carol@leave-cal.test", "carol-password");
    const res = await fetchWorker(`/v1/leave/requests/${request.leave_request_id}`, {
      headers: sessionHeaders(carol),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      team_overlaps: Array<{ employee_name: string }>;
      balance_after_days: number;
      working_days: number;
    };
    expect(body.team_overlaps.map((o) => o.employee_name)).toEqual(["Bob Dev"]);
    expect(body.working_days).toBe(3);
    // Annual entitlement is 8 in the provisional defaults, so approving leaves 5.
    expect(body.balance_after_days).toBe(5);
  });
});
