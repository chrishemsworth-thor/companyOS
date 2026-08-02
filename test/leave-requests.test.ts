import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { validatePayload } from "../src/schemas/events/registry";
import type { EventEnvelope } from "../src/schemas/envelope";
import { ulid } from "../src/lib/ulid";
import {
  applyHalfDays,
  calendarDays,
  countWorkingDays,
  isIsoDate,
  spansOverlap,
  workingDaysFor,
} from "../src/modules/people/leave/calendar";
import { PROVISIONAL_DEFAULTS } from "../src/modules/people/leave/policy-port";
import {
  getBalances,
  previewLeaveRequest,
  submitLeaveRequest,
  LeaveError,
} from "../src/modules/people/leave/service";
import type { WorkCalendar } from "../src/modules/people/leave/types";

/**
 * PRD-006c — leave request submission, working-day counting and balances.
 *
 * Covers PRD-006 § "Leave: request and approval" acceptance criteria 3, 4 and 5
 * (over-balance blocked with the shortfall stated, attachment-required refused,
 * same-employee overlap 409) plus the two balance criteria from § "Leave: policy
 * and entitlement" that S7 owns the consumption half of — a pending request
 * reduces available balance immediately, and a rejected one restores it.
 * Criteria 1 and 2 (notification + pending approval, decrement on approval) live
 * in test/leave-approval.test.ts, which is where the approvals primitive is
 * exercised.
 *
 * The working-day exclusion criteria from § "Leave: public holidays" are tested
 * here at the pure-function level against a supplied calendar. S6 owns *sourcing*
 * the work week and the state holiday set; S7 owns *applying* whatever it is
 * given, and that boundary is exactly what `countWorkingDays` is.
 *
 * Isolated-storage note: D1 writes inside an `it` are rolled back before the
 * next, so shared fixtures (tenant, users, employees) are seeded in `beforeAll`,
 * which persists for the file. Leave requests are created per test.
 */

const WORKSPACE = "leave-req-co";
const TENANT_ID = "biz_leave_req";
const API_KEY = "test_api_key_leave_req";

const OTHER_WORKSPACE = "leave-req-other-co";
const OTHER_TENANT_ID = "biz_leave_req_other";
const OTHER_API_KEY = "test_api_key_leave_req_other";

const ORIGIN = "http://localhost:5173";

/**
 * A year far enough ahead that "future leave" stays future for the life of this
 * repo, and whose dates are pinned to known weekdays below. Hardcoding the year
 * rather than deriving it from `now` is what keeps the weekday assertions from
 * breaking every January.
 */
const YEAR = 2027;
/** 2027-03-01 is a Monday. Every date below is stated relative to that. */
const MON = `${YEAR}-03-01`;
const TUE = `${YEAR}-03-02`;
const WED = `${YEAR}-03-03`;
const THU = `${YEAR}-03-04`;
const FRI = `${YEAR}-03-05`;
const SAT = `${YEAR}-03-06`;
const SUN = `${YEAR}-03-07`;
const NEXT_MON = `${YEAR}-03-08`;
const NEXT_TUE = `${YEAR}-03-09`;

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

async function login(email: string, password: string, workspace = WORKSPACE): Promise<Session> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace, email, password }),
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

/**
 * An env whose event bus records instead of dispatching, so the exact payload is
 * inspectable and can be run through the registry. Same helper as
 * test/approvals.test.ts.
 */
function capturingEnv(): { env: Env; sent: EventEnvelope[] } {
  const sent: EventEnvelope[] = [];
  const bus = {
    async send(message: unknown) {
      sent.push(message as EventEnvelope);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
      for (const m of messages) sent.push(m.body as EventEnvelope);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  return { env: { ...(env as unknown as Env), EVENTS: bus as unknown as Queue }, sent };
}

type UserKey = "admin" | "staff" | "manager" | "hr" | "otherAdmin";
const user = {} as Record<UserKey, string>;

const EMP_STAFF = "emp_lvr_staff";
const EMP_MANAGER = "emp_lvr_manager";
const EMP_HR = "emp_lvr_hr";
/** An employee with no console login, for the HR-files-on-behalf case. */
const EMP_NOLOGIN = "emp_lvr_nologin";

beforeAll(async () => {
  for (const [tenantId, name, slug, key] of [
    [TENANT_ID, "Leave Request Tenant", WORKSPACE, API_KEY],
    [OTHER_TENANT_ID, "Other Leave Tenant", OTHER_WORKSPACE, OTHER_API_KEY],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(tenantId, name, slug, await sha256Hex(key))
      .run();
  }

  const seeded: ReadonlyArray<[UserKey, string, string, Parameters<typeof createUser>[1]["role"]]> = [
    ["admin", "admin@leave-req.test", "admin-password", "admin"],
    // `employee` role: the self-service tier, holding `self` and `meta` only.
    // The person filing leave is normally exactly this, so it is what the
    // employee-side tests use.
    ["staff", "staff@leave-req.test", "staff-password", "employee"],
    ["manager", "manager@leave-req.test", "manager-password", "employee"],
    ["hr", "hr@leave-req.test", "hr-password", "operator"],
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

  user.otherAdmin = (
    await createUser(env.DB, {
      tenant_id: OTHER_TENANT_ID,
      email: "admin@other-leave.test",
      password: "other-admin-password",
      role: "admin",
    })
  ).user_id;

  await env.DB.prepare(
    "INSERT OR IGNORE INTO teams (team_id, tenant_id, name, department_id) VALUES (?, ?, ?, ?)",
  )
    .bind("team_lvr", TENANT_ID, "Delivery", "operations")
    .run();

  // Managers before reports (FK on (tenant_id, manager_employee_id)).
  for (const [id, name, login, team] of [
    [EMP_MANAGER, "Line Manager", "manager", "team_lvr"],
    [EMP_HR, "HR Person", "hr", null],
    [EMP_STAFF, "Staff Member", "staff", "team_lvr"],
    [EMP_NOLOGIN, "No Login Colleague", null, "team_lvr"],
  ] as const) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO employees
         (employee_id, tenant_id, name, department_id, user_id, team_id, start_date, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        TENANT_ID,
        name,
        "operations",
        login ? user[login as UserKey] : null,
        team,
        `${YEAR - 3}-01-01`,
        "Selangor",
      )
      .run();
  }
  for (const id of [EMP_STAFF, EMP_NOLOGIN]) {
    await env.DB.prepare(
      "UPDATE employees SET manager_employee_id = ? WHERE tenant_id = ? AND employee_id = ?",
    )
      .bind(EMP_MANAGER, TENANT_ID, id)
      .run();
  }
});

/**
 * A stored file row, bypassing the upload route.
 *
 * The service only ever checks the row (tenant, purpose, not deleted), so
 * putting real bytes in R2 to test the leave path would prove nothing the files
 * suite does not already prove. `sha256` is NOT NULL in 0021, hence the stub.
 */
async function seedFile(fileId: string, purpose: string, filename: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO files
       (file_id, tenant_id, purpose, filename, content_type, size_bytes, sha256, r2_key)
     VALUES (?, ?, ?, ?, 'image/jpeg', 2048, ?, ?)`,
  )
    .bind(fileId, TENANT_ID, purpose, filename, `sha-${fileId}`, `k/${fileId}`)
    .run();
}

/** Mon–Fri with no holidays — the provisional fallback, stated explicitly. */
const MON_FRI: WorkCalendar = {
  workDays: new Set([1, 2, 3, 4, 5]),
  holidays: new Set(),
  source: "default",
};

/* ------------------------------------------------------- working-day maths */

describe("working-day counting (PRD-006 § public holidays)", () => {
  it("deducts only working days across a weekend and a state holiday", () => {
    // Mon–next Tue is 9 calendar days: 7 weekdays, minus Wed as a state holiday,
    // minus the Sat/Sun in between.
    const calendar: WorkCalendar = {
      workDays: new Set([1, 2, 3, 4, 5]),
      holidays: new Set([WED]),
      source: "policy",
    };
    const counted = countWorkingDays(MON, NEXT_TUE, calendar);

    expect(calendarDays(MON, NEXT_TUE)).toBe(9);
    expect(counted.workingDays).toBe(6);
    expect(counted.excluded).toEqual([
      { date: WED, reason: "public_holiday" },
      { date: SAT, reason: "non_working_day" },
      { date: SUN, reason: "non_working_day" },
    ]);
  });

  it("applies each employee's own holiday set (two states, two answers)", () => {
    // The same span, counted against a Selangor holiday and a Penang one. This
    // is PRD-006's "given employees in two states, then each has their own
    // holiday set applied" at the layer S7 owns — S6 sources the sets.
    const selangor: WorkCalendar = { ...MON_FRI, holidays: new Set([TUE]), source: "policy" };
    const penang: WorkCalendar = { ...MON_FRI, holidays: new Set([THU]), source: "policy" };

    expect(countWorkingDays(MON, FRI, selangor).excluded).toEqual([
      { date: TUE, reason: "public_holiday" },
    ]);
    expect(countWorkingDays(MON, FRI, penang).excluded).toEqual([
      { date: THU, reason: "public_holiday" },
    ]);
    // Same total, different days off — which is the point: a manager comparing
    // two employees' deductions must be able to see why they differ.
    expect(countWorkingDays(MON, FRI, selangor).workingDays).toBe(4);
    expect(countWorkingDays(MON, FRI, penang).workingDays).toBe(4);
  });

  it("reflects a Sun–Thu work week (Kelantan, Terengganu)", () => {
    const sunThu: WorkCalendar = {
      workDays: new Set([0, 1, 2, 3, 4]),
      holidays: new Set(),
      source: "policy",
    };
    // Mon–Sun: Fri and Sat are the weekend, so 5 working days and the excluded
    // pair is Fri/Sat rather than Sat/Sun.
    const counted = countWorkingDays(MON, SUN, sunThu);
    expect(counted.workingDays).toBe(5);
    expect(counted.excluded).toEqual([
      { date: FRI, reason: "non_working_day" },
      { date: SAT, reason: "non_working_day" },
    ]);
  });

  it("counts a holiday landing on a non-working day as a non-working day", () => {
    // Not a pedantic distinction: labelling it a holiday would imply the
    // employee was given something for it.
    const calendar: WorkCalendar = { ...MON_FRI, holidays: new Set([SAT]) };
    expect(countWorkingDays(SAT, SAT, calendar).excluded).toEqual([
      { date: SAT, reason: "non_working_day" },
    ]);
  });

  it("halves the count at either end, and both ends of a one-day span", () => {
    const week = countWorkingDays(MON, FRI, MON_FRI);
    expect(applyHalfDays(week, false, false)).toBe(5);
    expect(applyHalfDays(week, true, false)).toBe(4.5);
    expect(applyHalfDays(week, false, true)).toBe(4.5);
    expect(applyHalfDays(week, true, true)).toBe(4);

    // One working day with both flags set is half of that day, not none of it.
    const oneDay = countWorkingDays(MON, MON, MON_FRI);
    expect(applyHalfDays(oneDay, true, true)).toBe(0.5);
    expect(applyHalfDays(oneDay, true, false)).toBe(0.5);
    expect(applyHalfDays(oneDay, false, false)).toBe(1);
  });

  it("applies a half day to the first working date, not the first calendar date", () => {
    // Saturday through the following Tuesday with start_half_day: the half
    // applies to Monday (the first day actually worked), so 2 working days
    // become 1.5. Applying it to Saturday would deduct half a day nobody was
    // working.
    const counted = workingDaysFor(SAT, NEXT_TUE, MON_FRI, true, false);
    expect(counted.workingDays).toBe(1.5);
  });

  it("counts a span entirely on non-working days as zero", () => {
    expect(countWorkingDays(SAT, SUN, MON_FRI).workingDays).toBe(0);
    expect(applyHalfDays(countWorkingDays(SAT, SUN, MON_FRI), true, true)).toBe(0);
  });

  it("validates and rejects impossible dates", () => {
    expect(isIsoDate(MON)).toBe(true);
    expect(isIsoDate("2027-02-30")).toBe(false);
    expect(isIsoDate("2027-13-01")).toBe(false);
    expect(isIsoDate("01-03-2027")).toBe(false);
    expect(isIsoDate("2027-3-1")).toBe(false);
  });

  it("detects span overlap inclusively at the boundary", () => {
    expect(spansOverlap(MON, WED, WED, FRI)).toBe(true);
    expect(spansOverlap(MON, TUE, WED, FRI)).toBe(false);
    expect(spansOverlap(MON, FRI, TUE, WED)).toBe(true);
  });
});

/* ------------------------------------------------------------- the S6 seam */

describe("the S6 policy seam", () => {
  it("falls back to provisional defaults while S6's tables are absent", async () => {
    // This test documents the seam rather than blessing it: while S6 is
    // unmerged, `leave_types` does not exist and the port supplies PRD-006's
    // seed list. When S6 lands this should start reading its table — and the
    // `entitlement_source` assertions below are what will fail loudly if the
    // reconciliation is forgotten.
    const res = await fetchWorker("/v1/leave/types", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ code: string }> };
    expect(body.items.map((t) => t.code)).toEqual(
      PROVISIONAL_DEFAULTS.leaveTypes.map((t) => t.code),
    );
    // PRD-006's seven named Malaysian defaults, all present.
    expect(body.items.map((t) => t.code).sort()).toEqual([
      "annual",
      "compassionate",
      "hospitalisation",
      "maternity",
      "paternity",
      "sick",
      "unpaid",
    ]);
  });

  it("marks a provisional balance as such, so a console cannot present it as policy", async () => {
    const balances = await getBalances(env as unknown as Env, TENANT_ID, EMP_STAFF, YEAR);
    const annual = balances.find((b) => b.leave_type_code === "annual")!;
    expect(annual.entitlement_source).toBe("default");
    expect(annual.entitlement_days).toBe(PROVISIONAL_DEFAULTS.entitlementDays.annual);
  });
});

/* -------------------------------------------------------------- the preview */

describe("preview (PRD-006: working days shown BEFORE submission)", () => {
  it("returns working days, excluded days and the balance after approval", async () => {
    const staff = await login("staff@leave-req.test", "staff-password");
    const res = await fetchWorker("/v1/leave/preview", {
      method: "POST",
      headers: sessionHeaders(staff),
      body: JSON.stringify({ leave_type_code: "annual", start_date: MON, end_date: SUN }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      working_days: number;
      calendar_days: number;
      excluded_days: Array<{ date: string; reason: string }>;
      balance: { available_days: number };
      balance_after_days: number;
      blockers: unknown[];
    };

    expect(body.calendar_days).toBe(7);
    expect(body.working_days).toBe(5);
    expect(body.excluded_days).toEqual([
      { date: SAT, reason: "non_working_day" },
      { date: SUN, reason: "non_working_day" },
    ]);
    // The fallback annual entitlement is 8 days, so 8 − 5 = 3 left.
    expect(body.balance.available_days).toBe(8);
    expect(body.balance_after_days).toBe(3);
    expect(body.blockers).toEqual([]);
  });

  it("is reachable by the self-service tier with no business capability", async () => {
    // The whole reason leave is mounted on `self`: an `employee` role holds no
    // `people:read`, and must still be able to plan their own leave.
    const staff = await login("staff@leave-req.test", "staff-password");
    const res = await fetchWorker("/v1/leave/balances", { headers: sessionHeaders(staff) });
    expect(res.status).toBe(200);
  });

  it("refuses to preview another employee's leave without people:read", async () => {
    const staff = await login("staff@leave-req.test", "staff-password");
    const res = await fetchWorker("/v1/leave/preview", {
      method: "POST",
      headers: sessionHeaders(staff),
      body: JSON.stringify({
        employee_id: EMP_MANAGER,
        leave_type_code: "annual",
        start_date: MON,
        end_date: MON,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an end date before the start date", async () => {
    const staff = await login("staff@leave-req.test", "staff-password");
    const res = await fetchWorker("/v1/leave/preview", {
      method: "POST",
      headers: sessionHeaders(staff),
      body: JSON.stringify({ leave_type_code: "annual", start_date: FRI, end_date: MON }),
    });
    expect(res.status).toBe(400);
  });

  it("422s an unknown leave type", async () => {
    const staff = await login("staff@leave-req.test", "staff-password");
    const res = await fetchWorker("/v1/leave/preview", {
      method: "POST",
      headers: sessionHeaders(staff),
      body: JSON.stringify({ leave_type_code: "sabbatical", start_date: MON, end_date: MON }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "unknown_leave_type" });
  });

  it("blocks a span with no working days in it", async () => {
    const staff = await login("staff@leave-req.test", "staff-password");
    const res = await fetchWorker("/v1/leave/preview", {
      method: "POST",
      headers: sessionHeaders(staff),
      body: JSON.stringify({ leave_type_code: "annual", start_date: SAT, end_date: SUN }),
    });
    const body = (await res.json()) as { blockers: Array<{ code: string }> };
    expect(body.blockers.map((b) => b.code)).toContain("no_working_days");
  });

  it("warns that policy is not configured while the fallback is in use", async () => {
    const staff = await login("staff@leave-req.test", "staff-password");
    const res = await fetchWorker("/v1/leave/preview", {
      method: "POST",
      headers: sessionHeaders(staff),
      body: JSON.stringify({ leave_type_code: "annual", start_date: MON, end_date: MON }),
    });
    const body = (await res.json()) as { warnings: Array<{ code: string }> };
    expect(body.warnings.map((w) => w.code)).toContain("policy_not_configured");
  });
});

/* --------------------------------------------------------------- submission */

describe("submission", () => {
  it("creates a pending request and emits a registry-valid leave.requested", async () => {
    const { env: capturing, sent } = capturingEnv();
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
      reason: "Family trip",
    });

    expect(request.state).toBe("pending");
    expect(request.working_days).toBe(3);
    expect(request.employee_name).toBe("Staff Member");
    expect(request.approval_id).toMatch(/^apr_/);

    const requested = sent.find((e) => e.event_type === "leave.requested")!;
    expect(requested).toBeDefined();
    expect(requested.source_module).toBe("people");
    expect(validatePayload("leave.requested", requested.payload)).toEqual({ ok: true });
    expect(requested.payload).toMatchObject({
      leave_request_id: request.leave_request_id,
      employee_id: EMP_STAFF,
      employee_user_id: user.staff,
      working_days: 3,
      requested_by: user.staff,
    });
  });

  it("stores a half-day request as a fractional working-day count", async () => {
    const { env: capturing } = capturingEnv();
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      start_half_day: true,
      requested_by: user.staff,
    });
    expect(request.working_days).toBe(2.5);
    expect(request.start_half_day).toBe(true);
    expect(request.end_half_day).toBe(false);
  });

  it("refuses a half day on a leave type that does not allow one", async () => {
    const { env: capturing } = capturingEnv();
    // Hospitalisation leave is whole-day in the provisional defaults.
    await expect(
      submitLeaveRequest(capturing, TENANT_ID, {
        employee_id: EMP_STAFF,
        leave_type_code: "hospitalisation",
        start_date: MON,
        end_date: MON,
        start_half_day: true,
        requested_by: user.staff,
        attachment_file_id: null,
      }),
    ).rejects.toMatchObject({ httpStatus: 422 });
  });

  it("enforces max_consecutive_days", async () => {
    const { env: capturing } = capturingEnv();
    // Compassionate leave caps at 5 consecutive working days in the defaults;
    // Mon–next Tue is 6.
    await expect(
      submitLeaveRequest(capturing, TENANT_ID, {
        employee_id: EMP_STAFF,
        leave_type_code: "compassionate",
        start_date: MON,
        end_date: NEXT_TUE,
        requested_by: user.staff,
      }),
    ).rejects.toMatchObject({ httpStatus: 422 });
  });

  it("lets HR file leave for an employee with no console login", async () => {
    const { env: capturing, sent } = capturingEnv();
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_NOLOGIN,
      leave_type_code: "annual",
      start_date: MON,
      end_date: MON,
      requested_by: user.hr,
    });
    expect(request.employee_id).toBe(EMP_NOLOGIN);
    // `employee_user_id` is null and that is fine — the payload says so rather
    // than a consumer having to look it up and find nothing.
    const requested = sent.find((e) => e.event_type === "leave.requested")!;
    expect(requested.payload.employee_user_id).toBeNull();
    expect(validatePayload("leave.requested", requested.payload)).toEqual({ ok: true });
  });

  it("routes the approval up the SUBJECT's reporting line, not the filer's", async () => {
    // HR files for a staff member: the approval must land on the staff member's
    // manager, not on HR's. This is what `subject_employee_id` is for.
    const { env: capturing } = capturingEnv();
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: MON,
      requested_by: user.hr,
    });
    const approval = await env.DB.prepare(
      "SELECT approver_user_id FROM approvals WHERE tenant_id = ? AND approval_id = ?",
    )
      .bind(TENANT_ID, request.approval_id)
      .first<{ approver_user_id: string }>();
    expect(approval?.approver_user_id).toBe(user.manager);
  });

  it("refuses a file that was not uploaded as a leave_attachment", async () => {
    const { env: capturing } = capturingEnv();
    const fileId = `fil_${ulid()}`;
    await seedFile(fileId, "claim_receipt", "receipt.jpg");

    // Pointing a leave request at somebody's expense receipt would have the
    // approval card render it to whoever approves the leave.
    await expect(
      submitLeaveRequest(capturing, TENANT_ID, {
        employee_id: EMP_STAFF,
        leave_type_code: "annual",
        start_date: MON,
        end_date: MON,
        requested_by: user.staff,
        attachment_file_id: fileId,
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("201s over HTTP and returns the created request", async () => {
    const staff = await login("staff@leave-req.test", "staff-password");
    const res = await fetchWorker("/v1/leave/requests", {
      method: "POST",
      headers: sessionHeaders(staff),
      body: JSON.stringify({
        leave_type_code: "annual",
        start_date: MON,
        end_date: TUE,
        reason: "Long weekend",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { state: string; working_days: number; employee_id: string };
    expect(body).toMatchObject({ state: "pending", working_days: 2, employee_id: EMP_STAFF });
  });
});

/* ------------------------------------------------- acceptance: over-balance */

describe("acceptance: a request exceeding available balance is blocked with the shortfall", () => {
  it("422s and states the shortfall", async () => {
    const { env: capturing } = capturingEnv();
    // Annual entitlement is 8 in the provisional defaults; ask for 10 working
    // days (Mon–next Fri, two full weeks minus the weekend).
    let thrown: LeaveError | null = null;
    try {
      await submitLeaveRequest(capturing, TENANT_ID, {
        employee_id: EMP_STAFF,
        leave_type_code: "annual",
        start_date: MON,
        end_date: `${YEAR}-03-12`,
        requested_by: user.staff,
      });
    } catch (err) {
      thrown = err as LeaveError;
    }

    expect(thrown).toBeInstanceOf(LeaveError);
    expect(thrown!.httpStatus).toBe(422);
    expect(thrown!.detail).toMatchObject({ code: "insufficient_balance" });
    // The shortfall is stated, not merely implied — PRD-006's wording.
    expect(thrown!.message).toContain("short by 2");
    const blockers = thrown!.detail!.blockers as Array<{
      code: string;
      shortfall_days?: number;
      available_days?: number;
    }>;
    expect(blockers.find((b) => b.code === "insufficient_balance")).toMatchObject({
      shortfall_days: 2,
      available_days: 8,
    });
  });

  it("permits it on a leave type that allows a negative balance", async () => {
    const { env: capturing } = capturingEnv();
    // Unpaid leave has zero entitlement by definition — the exception PRD-006
    // states on the blocking criterion.
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "unpaid",
      start_date: MON,
      end_date: FRI,
      requested_by: user.staff,
    });
    expect(request.state).toBe("pending");
    expect(request.working_days).toBe(5);
  });

  it("surfaces the shortfall over HTTP as 422 with structured detail", async () => {
    const staff = await login("staff@leave-req.test", "staff-password");
    const res = await fetchWorker("/v1/leave/requests", {
      method: "POST",
      headers: sessionHeaders(staff),
      body: JSON.stringify({
        leave_type_code: "annual",
        start_date: MON,
        end_date: `${YEAR}-03-12`,
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; blockers: Array<{ code: string }> };
    expect(body.code).toBe("insufficient_balance");
    expect(body.blockers.map((b) => b.code)).toContain("insufficient_balance");
  });
});

/* -------------------------------------------- acceptance: attachment needed */

describe("acceptance: a leave type requiring an attachment refuses submission without one", () => {
  it("422s when the document is missing", async () => {
    const { env: capturing } = capturingEnv();
    await expect(
      submitLeaveRequest(capturing, TENANT_ID, {
        employee_id: EMP_STAFF,
        leave_type_code: "sick",
        start_date: MON,
        end_date: MON,
        requested_by: user.staff,
      }),
    ).rejects.toMatchObject({ httpStatus: 422, detail: { code: "attachment_required" } });
  });

  it("accepts it when a leave_attachment file is supplied", async () => {
    const { env: capturing } = capturingEnv();
    const fileId = `fil_${ulid()}`;
    await seedFile(fileId, "leave_attachment", "mc.jpg");

    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "sick",
      start_date: MON,
      end_date: MON,
      requested_by: user.staff,
      attachment_file_id: fileId,
    });
    expect(request.state).toBe("pending");
    expect(request.attachment_file_id).toBe(fileId);
  });
});

/* ----------------------------------------------- acceptance: overlap is 409 */

describe("acceptance: overlapping dates with the same employee's existing request is 409", () => {
  it("409s and names the conflicting request", async () => {
    const { env: capturing } = capturingEnv();
    const first = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: TUE,
      end_date: THU,
      requested_by: user.staff,
    });

    let thrown: LeaveError | null = null;
    try {
      await submitLeaveRequest(capturing, TENANT_ID, {
        employee_id: EMP_STAFF,
        leave_type_code: "annual",
        start_date: WED,
        end_date: FRI,
        requested_by: user.staff,
      });
    } catch (err) {
      thrown = err as LeaveError;
    }
    expect(thrown!.httpStatus).toBe(409);
    expect(thrown!.detail).toMatchObject({
      code: "overlapping_request",
    });
    const blockers = thrown!.detail!.blockers as Array<{
      code: string;
      conflicting_leave_request_id?: string;
    }>;
    expect(
      blockers.find((b) => b.code === "overlapping_request")?.conflicting_leave_request_id,
    ).toBe(first.leave_request_id);
  });

  it("409s across DIFFERENT leave types — you cannot be on two kinds of leave at once", async () => {
    const { env: capturing } = capturingEnv();
    await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: TUE,
      end_date: WED,
      requested_by: user.staff,
    });
    await expect(
      submitLeaveRequest(capturing, TENANT_ID, {
        employee_id: EMP_STAFF,
        leave_type_code: "unpaid",
        start_date: WED,
        end_date: THU,
        requested_by: user.staff,
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("allows adjacent, non-overlapping requests", async () => {
    const { env: capturing } = capturingEnv();
    await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: TUE,
      requested_by: user.staff,
    });
    const second = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: WED,
      end_date: THU,
      requested_by: user.staff,
    });
    expect(second.state).toBe("pending");
  });

  it("does not block a DIFFERENT employee over the same dates", async () => {
    const { env: capturing } = capturingEnv();
    await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: TUE,
      requested_by: user.staff,
    });
    const other = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_NOLOGIN,
      leave_type_code: "annual",
      start_date: MON,
      end_date: TUE,
      requested_by: user.hr,
    });
    expect(other.state).toBe("pending");
  });
});

/* ------------------------------------------------- acceptance: balance maths */

describe("acceptance: pending reduces balance immediately, rejection restores it", () => {
  it("reduces available balance by the pending working days", async () => {
    const { env: capturing } = capturingEnv();
    const before = await getBalances(capturing, TENANT_ID, EMP_STAFF, YEAR);
    expect(before.find((b) => b.leave_type_code === "annual")!.available_days).toBe(8);

    await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });

    const after = await getBalances(capturing, TENANT_ID, EMP_STAFF, YEAR);
    const annual = after.find((b) => b.leave_type_code === "annual")!;
    // PRD-006: "given a pending 3-day request, then available balance is
    // reduced by 3 immediately."
    expect(annual.pending_days).toBe(3);
    expect(annual.taken_days).toBe(0);
    expect(annual.available_days).toBe(5);
  });

  it("restores the balance when the request is rejected", async () => {
    const { env: capturing } = capturingEnv();
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });
    expect(
      (await getBalances(capturing, TENANT_ID, EMP_STAFF, YEAR)).find(
        (b) => b.leave_type_code === "annual",
      )!.available_days,
    ).toBe(5);

    // `rejected` is not a consuming state, so the days come straight back with
    // no compensating write anywhere.
    await env.DB.prepare(
      "UPDATE leave_requests SET state = 'rejected' WHERE tenant_id = ? AND leave_request_id = ?",
    )
      .bind(TENANT_ID, request.leave_request_id)
      .run();

    const annual = (await getBalances(capturing, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    expect(annual.available_days).toBe(8);
    expect(annual.pending_days).toBe(0);
  });

  it("keeps available unchanged when a pending request is approved", async () => {
    // The reason approval needs no atomicity guarantee: the days were already
    // deducted at submission and merely move from the pending bucket to taken.
    const { env: capturing } = capturingEnv();
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });
    await env.DB.prepare(
      "UPDATE leave_requests SET state = 'approved' WHERE tenant_id = ? AND leave_request_id = ?",
    )
      .bind(TENANT_ID, request.leave_request_id)
      .run();

    const annual = (await getBalances(capturing, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    expect(annual.taken_days).toBe(3);
    expect(annual.pending_days).toBe(0);
    expect(annual.available_days).toBe(5);
  });

  it("counts a cancellation-pending request as still consuming", async () => {
    // The leave is still booked until somebody agrees to hand it back.
    const { env: capturing } = capturingEnv();
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });
    await env.DB.prepare(
      "UPDATE leave_requests SET state = 'cancellation_pending' WHERE tenant_id = ? AND leave_request_id = ?",
    )
      .bind(TENANT_ID, request.leave_request_id)
      .run();

    const annual = (await getBalances(capturing, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    expect(annual.available_days).toBe(5);
  });

  it("excludes a request from its own re-preview", async () => {
    // Otherwise re-previewing an existing request would look like the employee
    // had booked it twice.
    const { env: capturing } = capturingEnv();
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });
    const preview = await previewLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      exclude_request_id: request.leave_request_id,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.balance_after_days).toBe(5);
  });
});

/* ------------------------------------------------------- tenant isolation */

describe("tenant isolation", () => {
  it("404s another tenant's leave request id", async () => {
    const { env: capturing } = capturingEnv();
    const request = await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: MON,
      requested_by: user.staff,
    });

    const res = await fetchWorker(`/v1/leave/requests/${request.leave_request_id}`, {
      headers: { Authorization: `Bearer ${OTHER_API_KEY}` },
    });
    expect(res.status).toBe(404);
  });

  it("does not list another tenant's requests", async () => {
    const { env: capturing } = capturingEnv();
    await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: MON,
      requested_by: user.staff,
    });
    const res = await fetchWorker("/v1/leave/requests?scope=all", {
      headers: { Authorization: `Bearer ${OTHER_API_KEY}` },
    });
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
