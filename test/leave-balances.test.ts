import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { ulid } from "../src/lib/ulid";
import type {
  CarryForwardResult,
  LeaveBalance,
  LeavePolicy,
  LeaveType,
} from "../src/modules/leave/types";

/**
 * PRD-006b — leave balances.
 *
 * PRD-006's success metric names this file: *"Leave balance correctness across
 * mid-year joins, carry-forward, and state holidays is covered by tests,
 * because a wrong balance destroys trust permanently."*
 *
 * `leave_requests` rows are inserted directly through `env.DB` rather than
 * through an API. That is deliberate and documented in `0025_leave_policy.sql`:
 * S6 owns the balance arithmetic and the table's balance-relevant columns, S7
 * (PRD-006c) owns the request write path, the state machine and the `leave.*`
 * events. Testing the arithmetic cannot wait for S7, because the arithmetic is
 * what S6 ships.
 */

const API_KEY = "test_api_key_leave_balances";
const TENANT_ID = "biz_leave_balances";
const WORKSPACE = "leave-balances-co";
const ORIGIN = "http://localhost:5173";

const bearer = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createEmployee(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await fetchWorker("/v1/people/employees", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({ name, department_id: "operations", ...extra }),
  });
  return ((await res.json()) as { employee_id: string }).employee_id;
}

async function annualTypeId(): Promise<string> {
  const res = await fetchWorker("/v1/people/leave/types", { headers: bearer });
  const { leave_types } = (await res.json()) as { leave_types: LeaveType[] };
  return leave_types.find((t) => t.code === "annual")!.leave_type_id;
}

/** A policy with one flat band — the shape most of these tests want. */
async function makePolicy(
  leaveTypeId: string,
  entitlementDays: number,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await fetchWorker("/v1/people/leave/policies", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      leave_type_id: leaveTypeId,
      name: `Test policy ${entitlementDays}d ${ulid()}`,
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: entitlementDays }],
      ...extra,
    }),
  });
  return ((await res.json()) as { policy: LeavePolicy }).policy.policy_id;
}

async function assign(
  employeeId: string,
  leaveTypeId: string,
  policyId: string,
  override?: number,
): Promise<Response> {
  return fetchWorker("/v1/people/leave/assignments", {
    method: "PUT",
    headers: bearer,
    body: JSON.stringify({
      employee_id: employeeId,
      leave_type_id: leaveTypeId,
      policy_id: policyId,
      entitlement_days_override: override ?? null,
    }),
  });
}

/**
 * Insert a leave request directly. S7 owns the write path; this is the balance
 * engine's input, and the columns used here are exactly the ones the migration
 * declares as S6-owned.
 */
async function seedRequest(input: {
  employee_id: string;
  leave_type_id: string;
  start: string;
  end: string;
  working_days: number;
  state?: "pending" | "approved" | "rejected" | "cancelled";
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO leave_requests (
       leave_request_id, tenant_id, employee_id, leave_type_id, start_date, end_date,
       working_days, state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `lvr_${ulid()}`,
      TENANT_ID,
      input.employee_id,
      input.leave_type_id,
      input.start,
      input.end,
      input.working_days,
      input.state ?? "pending",
    )
    .run();
}

async function balanceFor(
  employeeId: string,
  leaveTypeId: string,
  asOf: string,
): Promise<LeaveBalance> {
  const res = await fetchWorker(
    `/v1/people/leave/balances?employee_id=${employeeId}&as_of=${asOf}&leave_type_id=${leaveTypeId}`,
    { headers: bearer },
  );
  const body = (await res.json()) as { balances: LeaveBalance[] };
  return body.balances[0]!;
}

async function yearClose(body: Record<string, unknown>): Promise<CarryForwardResult[]> {
  const res = await fetchWorker("/v1/people/leave/year-close", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify(body),
  });
  return ((await res.json()) as { results: CarryForwardResult[] }).results;
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(TENANT_ID, "Leave Balances Tenant", WORKSPACE, await sha256Hex(API_KEY))
    .run();
  await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: "staff@leavebalances.test",
    password: "employee-password",
    role: "employee",
  });
});

describe("entitlement and pro-rating", () => {
  /**
   * PRD-006 acceptance criterion: "Given an employee joining on 1 July with a
   * 14-day annual entitlement and upfront accrual, then their first-year
   * balance is pro-rated to 7 days."
   */
  it("pro-rates a 1 July joiner on a 14-day upfront entitlement to 7 days", async () => {
    const employee = await createEmployee("July Joiner", { start_date: "2026-07-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));

    const balance = await balanceFor(employee, typeId, "2026-12-31");
    expect(balance.full_entitlement_days).toBe(14);
    expect(balance.entitlement_days).toBe(7);
    expect(balance.available_days).toBe(7);
    expect(balance.period_start).toBe("2026-01-01");
    expect(balance.period_end).toBe("2026-12-31");
  });

  it("gives a January joiner the full entitlement in the same year", async () => {
    const employee = await createEmployee("January Joiner", { start_date: "2026-01-05" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));
    expect((await balanceFor(employee, typeId, "2026-12-31")).entitlement_days).toBe(14);
  });

  it("pro-rates a leaver by the months they were there", async () => {
    const employee = await createEmployee("Mid-year Leaver", {
      start_date: "2020-01-01",
      end_date: "2026-06-30",
    });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 12));
    // January through June inclusive: 6 of 12 months.
    expect((await balanceFor(employee, typeId, "2026-12-31")).entitlement_days).toBe(6);
  });

  it("rounds a pro-rated entitlement to the nearest half day", async () => {
    // 14 days over 5 months (August joiner) is 5.833… — a balance nobody can
    // reconcile unless it is rounded.
    const employee = await createEmployee("August Joiner", { start_date: "2026-08-15" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));
    expect((await balanceFor(employee, typeId, "2026-12-31")).entitlement_days).toBe(6);
  });

  it("gives an employee who joins after the year ends nothing for that year", async () => {
    const employee = await createEmployee("Next Year Nadia", { start_date: "2027-03-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));
    expect((await balanceFor(employee, typeId, "2026-12-31")).entitlement_days).toBe(0);
  });

  it("picks the tenure band, evaluated at the end of the leave year", async () => {
    const employee = await createEmployee("Tenure Tan", { start_date: "2024-08-01" });
    const typeId = await annualTypeId();
    // Seeded Employment Act bands: 8 / 12 / 16.
    const res = await fetchWorker(`/v1/people/leave/policies?leave_type_id=${typeId}`, {
      headers: bearer,
    });
    const { policies } = (await res.json()) as { policies: LeavePolicy[] };
    await assign(employee, typeId, policies.find((p) => p.is_default)!.policy_id);

    // At end-2025 they have 17 months — under two years, so 8 days.
    expect((await balanceFor(employee, typeId, "2025-12-31")).full_entitlement_days).toBe(8);
    // At end-2026 they have 29 months, so the whole of 2026 is on 12 days —
    // the entitlement does not step up in August, mid-year.
    expect((await balanceFor(employee, typeId, "2026-06-01")).full_entitlement_days).toBe(12);
    expect((await balanceFor(employee, typeId, "2026-12-31")).full_entitlement_days).toBe(12);
  });

  it("prefers a band naming the employment type over a catch-all band", async () => {
    const intern = await createEmployee("Intern Iman", {
      start_date: "2026-01-01",
      employment_type: "intern",
    });
    const staff = await createEmployee("Staff Sara", {
      start_date: "2026-01-01",
      employment_type: "full_time",
    });
    const typeId = await annualTypeId();
    const res = await fetchWorker("/v1/people/leave/policies", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        leave_type_id: typeId,
        name: "Mixed bands",
        bands: [
          { entitlement_days: 14 },
          { employment_type: "intern", entitlement_days: 8 },
        ],
      }),
    });
    const policyId = ((await res.json()) as { policy: LeavePolicy }).policy.policy_id;
    await assign(intern, typeId, policyId);
    await assign(staff, typeId, policyId);

    expect((await balanceFor(intern, typeId, "2026-12-31")).full_entitlement_days).toBe(8);
    expect((await balanceFor(staff, typeId, "2026-12-31")).full_entitlement_days).toBe(14);
  });

  it("honours a per-employee entitlement override — a contract above minimum", async () => {
    const employee = await createEmployee("Contract Chan", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 12), 21);
    const balance = await balanceFor(employee, typeId, "2026-12-31");
    expect(balance.full_entitlement_days).toBe(21);
    expect(balance.available_days).toBe(21);
  });

  it("falls back to the leave type's default policy when nothing is assigned", async () => {
    const employee = await createEmployee("Unassigned Umar", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    const balance = await balanceFor(employee, typeId, "2026-12-31");
    // The seeded default: 5+ years of service → 16 days.
    expect(balance.full_entitlement_days).toBe(16);
    expect(balance.unconfigured).toBe(false);
  });

  it("marks a leave type with no policy at all as unconfigured, not as zero", async () => {
    const employee = await createEmployee("No Policy Nora", { start_date: "2020-01-01" });
    const create = await fetchWorker("/v1/people/leave/types", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ code: "study", name: "Study Leave" }),
    });
    const typeId = ((await create.json()) as { leave_type: LeaveType }).leave_type.leave_type_id;

    const balance = await balanceFor(employee, typeId, "2026-12-31");
    expect(balance.unconfigured).toBe(true);
    expect(balance.available_days).toBe(0);
    expect(balance.policy_id).toBeNull();
  });
});

describe("accrual methods", () => {
  it("accrues monthly, growing through the year", async () => {
    const employee = await createEmployee("Monthly Maya", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 12, { accrual_method: "monthly_accrual" }));

    // One day a month, counted once the month is behind us.
    expect((await balanceFor(employee, typeId, "2026-01-15")).entitlement_days).toBe(0);
    expect((await balanceFor(employee, typeId, "2026-04-15")).entitlement_days).toBe(3);
    expect((await balanceFor(employee, typeId, "2026-12-31")).entitlement_days).toBe(11);
  });

  it("accrues monthly from the joining month, not from January", async () => {
    const employee = await createEmployee("Monthly Mid-year", { start_date: "2026-07-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 12, { accrual_method: "monthly_accrual" }));
    // July through September are behind us on 1 October: 3 months of 12.
    expect((await balanceFor(employee, typeId, "2026-10-01")).entitlement_days).toBe(3);
  });

  it("runs an on-anniversary policy on the employee's own year", async () => {
    const employee = await createEmployee("Anniversary Amir", { start_date: "2020-07-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14, { accrual_method: "on_anniversary" }));

    const balance = await balanceFor(employee, typeId, "2026-08-01");
    expect(balance.period_start).toBe("2026-07-01");
    expect(balance.period_end).toBe("2027-06-30");
    // Granted in full at the anniversary — no pro-rating, because the period
    // itself starts there.
    expect(balance.entitlement_days).toBe(14);

    // Before this year's anniversary, the previous cycle still applies.
    const earlier = await balanceFor(employee, typeId, "2026-03-01");
    expect(earlier.period_start).toBe("2025-07-01");
    expect(earlier.period_end).toBe("2026-06-30");
  });
});

describe("taken, pending, and restoration", () => {
  /**
   * PRD-006 acceptance criterion: "Given a pending 3-day request, then
   * available balance is reduced by 3 immediately."
   */
  it("reduces the available balance the moment a request is pending", async () => {
    const employee = await createEmployee("Pending Priya", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));

    const before = await balanceFor(employee, typeId, "2026-06-01");
    expect(before.available_days).toBe(14);

    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2026-06-15",
      end: "2026-06-17",
      working_days: 3,
      state: "pending",
    });

    const after = await balanceFor(employee, typeId, "2026-06-01");
    expect(after.pending_days).toBe(3);
    expect(after.taken_days).toBe(0);
    // The point of the criterion: undecided days are gone from what you can
    // book, or people over-book against days they already asked for.
    expect(after.available_days).toBe(11);
  });

  /**
   * PRD-006 acceptance criterion: "Given a rejected request, then the balance
   * is restored."
   */
  it("restores the balance when a request is rejected", async () => {
    const employee = await createEmployee("Rejected Raj", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));

    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2026-06-15",
      end: "2026-06-17",
      working_days: 3,
      state: "pending",
    });
    expect((await balanceFor(employee, typeId, "2026-06-01")).available_days).toBe(11);

    await env.DB.prepare(
      "UPDATE leave_requests SET state = 'rejected' WHERE tenant_id = ? AND employee_id = ?",
    )
      .bind(TENANT_ID, employee)
      .run();

    const after = await balanceFor(employee, typeId, "2026-06-01");
    expect(after.pending_days).toBe(0);
    expect(after.available_days).toBe(14);
  });

  it("restores the balance when a request is cancelled", async () => {
    const employee = await createEmployee("Cancelled Chong", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));
    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2026-06-15",
      end: "2026-06-17",
      working_days: 3,
      state: "cancelled",
    });
    expect((await balanceFor(employee, typeId, "2026-06-01")).available_days).toBe(14);
  });

  it("counts approved days as taken and both against the same balance", async () => {
    const employee = await createEmployee("Mixed Mei", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));
    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2026-03-02",
      end: "2026-03-06",
      working_days: 5,
      state: "approved",
    });
    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2026-06-15",
      end: "2026-06-16",
      working_days: 2,
      state: "pending",
    });

    const balance = await balanceFor(employee, typeId, "2026-07-01");
    expect(balance.taken_days).toBe(5);
    expect(balance.pending_days).toBe(2);
    expect(balance.available_days).toBe(7);
  });

  it("charges a year-spanning request to each year's own balance", async () => {
    const employee = await createEmployee("New Year Nik", { start_date: "2020-01-01" });
    await fetchWorker("/v1/people/leave/employee-profiles", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ employee_id: employee, work_state: "SGR" }),
    });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));

    // Mon 28 Dec 2026 → Tue 5 Jan 2027. Six working days in total, but only
    // the four in December belong to the 2026 balance.
    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2026-12-28",
      end: "2027-01-05",
      working_days: 6,
      state: "approved",
    });

    expect((await balanceFor(employee, typeId, "2026-12-31")).taken_days).toBe(4);
    expect((await balanceFor(employee, typeId, "2027-01-31")).taken_days).toBe(2);
  });

  it("keeps each leave type's consumption to its own balance", async () => {
    const employee = await createEmployee("Two Types Tina", { start_date: "2020-01-01" });
    const annual = await annualTypeId();
    const res = await fetchWorker("/v1/people/leave/types", { headers: bearer });
    const sick = ((await res.json()) as { leave_types: LeaveType[] }).leave_types.find(
      (t) => t.code === "sick",
    )!.leave_type_id;

    await assign(employee, annual, await makePolicy(annual, 14));
    await seedRequest({
      employee_id: employee,
      leave_type_id: sick,
      start: "2026-03-02",
      end: "2026-03-04",
      working_days: 3,
      state: "approved",
    });

    expect((await balanceFor(employee, annual, "2026-06-01")).available_days).toBe(14);
    expect((await balanceFor(employee, sick, "2026-06-01")).taken_days).toBe(3);
  });

  it("applies a manual adjustment to the balance", async () => {
    const employee = await createEmployee("Adjusted Ali", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));

    const res = await fetchWorker("/v1/people/leave/adjustments", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        employee_id: employee,
        leave_type_id: typeId,
        leave_year: 2026,
        days: 2,
        note: "Goodwill day for the weekend deployment",
      }),
    });
    expect(res.status).toBe(201);

    const balance = await balanceFor(employee, typeId, "2026-06-01");
    expect(balance.adjustment_days).toBe(2);
    expect(balance.available_days).toBe(16);
  });
});

describe("carry-forward", () => {
  /**
   * PRD-006 acceptance criterion: "Given carry-forward capped at 5 days, then
   * a 9-day unused balance carries 5."
   */
  it("carries 5 of a 9-day unused balance when the cap is 5", async () => {
    const employee = await createEmployee("Carry Chandra", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(
      employee,
      typeId,
      await makePolicy(typeId, 14, { carry_forward_max_days: 5, carry_forward_expiry_months: null }),
    );
    // 14 entitled, 5 taken → 9 unused at the close of 2025.
    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2025-03-03",
      end: "2025-03-07",
      working_days: 5,
      state: "approved",
    });
    expect((await balanceFor(employee, typeId, "2025-12-31")).available_days).toBe(9);

    const results = await yearClose({ leave_year: 2025, employee_id: employee });
    const annual = results.find((r) => r.leave_type_id === typeId)!;
    expect(annual.unused_days).toBe(9);
    expect(annual.carried_days).toBe(5);
    expect(annual.capped).toBe(true);
    expect(annual.written).toBe(true);

    // And it shows up in the following year.
    const next = await balanceFor(employee, typeId, "2026-01-15");
    expect(next.carried_forward_days).toBe(5);
    expect(next.available_days).toBe(19); // 14 entitlement + 5 carried
  });

  it("carries the whole balance when it is under the cap", async () => {
    const employee = await createEmployee("Under Cap Umi", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(
      employee,
      typeId,
      await makePolicy(typeId, 14, { carry_forward_max_days: 10, carry_forward_expiry_months: null }),
    );
    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2025-03-03",
      end: "2025-03-14",
      working_days: 10,
      state: "approved",
    });
    const results = await yearClose({ leave_year: 2025, employee_id: employee });
    const annual = results.find((r) => r.leave_type_id === typeId)!;
    expect(annual.unused_days).toBe(4);
    expect(annual.carried_days).toBe(4);
    expect(annual.capped).toBe(false);
  });

  it("does not carry days that are still spoken for by a pending request", async () => {
    const employee = await createEmployee("Pending At Close", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(
      employee,
      typeId,
      await makePolicy(typeId, 14, { carry_forward_max_days: 10, carry_forward_expiry_months: null }),
    );
    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2025-12-22",
      end: "2025-12-24",
      working_days: 3,
      state: "pending",
    });
    const results = await yearClose({ leave_year: 2025, employee_id: employee });
    expect(results.find((r) => r.leave_type_id === typeId)!.unused_days).toBe(11);
  });

  it("is idempotent — closing the same year twice does not double the carry", async () => {
    const employee = await createEmployee("Twice Closed", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(
      employee,
      typeId,
      await makePolicy(typeId, 14, { carry_forward_max_days: 5, carry_forward_expiry_months: null }),
    );

    const first = await yearClose({ leave_year: 2025, employee_id: employee });
    expect(first.find((r) => r.leave_type_id === typeId)!.written).toBe(true);

    const second = await yearClose({ leave_year: 2025, employee_id: employee });
    // Reported honestly as "already closed" rather than claiming a write the
    // unique index would have dropped.
    expect(second.find((r) => r.leave_type_id === typeId)!.written).toBe(false);

    // And the balance is unchanged: 5 carried, not 10.
    expect((await balanceFor(employee, typeId, "2026-01-15")).carried_forward_days).toBe(5);
  });

  it("previews without writing when dry_run is set", async () => {
    const employee = await createEmployee("Dry Run Dina", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(
      employee,
      typeId,
      await makePolicy(typeId, 14, { carry_forward_max_days: 5, carry_forward_expiry_months: null }),
    );

    const results = await yearClose({ leave_year: 2025, employee_id: employee, dry_run: true });
    expect(results.find((r) => r.leave_type_id === typeId)!.carried_days).toBe(5);
    expect((await balanceFor(employee, typeId, "2026-01-15")).carried_forward_days).toBe(0);
  });

  it("carries nothing for a leave type that does not allow it", async () => {
    const employee = await createEmployee("No Carry Nur", { start_date: "2020-01-01" });
    const res = await fetchWorker("/v1/people/leave/types", { headers: bearer });
    const sick = ((await res.json()) as { leave_types: LeaveType[] }).leave_types.find(
      (t) => t.code === "sick",
    )!;
    expect(sick.carry_forward_allowed).toBe(false);

    const results = await yearClose({ leave_year: 2025, employee_id: employee });
    expect(results.find((r) => r.leave_type_id === sick.leave_type_id)).toBeUndefined();
  });

  it("lapses unused carried days at the expiry date, spending carried days first", async () => {
    const employee = await createEmployee("Expiry Eddy", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(
      employee,
      typeId,
      // Use them by 31 March or lose them — the common Malaysian setting.
      await makePolicy(typeId, 14, { carry_forward_max_days: 5, carry_forward_expiry_months: 3 }),
    );
    await env.DB.prepare(
      `INSERT INTO leave_balance_adjustments (
         adjustment_id, tenant_id, employee_id, leave_type_id, leave_year, days, kind
       ) VALUES (?, ?, ?, ?, 2026, 5, 'carry_forward')`,
    )
      .bind(`lva_${ulid()}`, TENANT_ID, employee, typeId)
      .run();

    // Before the cutoff, all five are live.
    const february = await balanceFor(employee, typeId, "2026-02-15");
    expect(february.carried_forward_days).toBe(5);
    expect(february.carry_forward_expired_days).toBe(0);
    expect(february.available_days).toBe(19);

    // After it, with none used, all five lapse — and the current year's
    // entitlement is untouched.
    const june = await balanceFor(employee, typeId, "2026-06-15");
    expect(june.carried_forward_days).toBe(0);
    expect(june.carry_forward_expired_days).toBe(5);
    expect(june.available_days).toBe(14);
  });

  it("keeps the carried days that were actually used before they lapsed", async () => {
    const employee = await createEmployee("Partial Expiry Pang", { start_date: "2020-01-01" });
    const typeId = await annualTypeId();
    await assign(
      employee,
      typeId,
      await makePolicy(typeId, 14, { carry_forward_max_days: 5, carry_forward_expiry_months: 3 }),
    );
    await env.DB.prepare(
      `INSERT INTO leave_balance_adjustments (
         adjustment_id, tenant_id, employee_id, leave_type_id, leave_year, days, kind
       ) VALUES (?, ?, ?, ?, 2026, 5, 'carry_forward')`,
    )
      .bind(`lva_${ulid()}`, TENANT_ID, employee, typeId)
      .run();
    // Three days taken in February, before the cutoff.
    await seedRequest({
      employee_id: employee,
      leave_type_id: typeId,
      start: "2026-02-09",
      end: "2026-02-11",
      working_days: 3,
      state: "approved",
    });

    const june = await balanceFor(employee, typeId, "2026-06-15");
    // Carried days are spent first, so February came out of the carried five;
    // two lapsed, and this year's 14 are all still there.
    expect(june.carried_forward_days).toBe(3);
    expect(june.carry_forward_expired_days).toBe(2);
    expect(june.taken_days).toBe(3);
    expect(june.available_days).toBe(14);
  });

  it("closes every active employee when no employee is named", async () => {
    const typeId = await annualTypeId();
    const a = await createEmployee("Bulk A", { start_date: "2020-01-01" });
    const b = await createEmployee("Bulk B", { start_date: "2020-01-01" });
    const policy = await makePolicy(typeId, 14, {
      carry_forward_max_days: 5,
      carry_forward_expiry_months: null,
    });
    await assign(a, typeId, policy);
    await assign(b, typeId, policy);

    const results = await yearClose({ leave_year: 2025 });
    const employees = new Set(results.map((r) => r.employee_id));
    expect(employees.has(a)).toBe(true);
    expect(employees.has(b)).toBe(true);
  });

  it("rejects a nonsense leave year", async () => {
    const res = await fetchWorker("/v1/people/leave/year-close", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ leave_year: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("employee self-service balance", () => {
  it("shows an employee their own balance and nobody else's", async () => {
    const login = await fetchWorker("/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        workspace: WORKSPACE,
        email: "staff@leavebalances.test",
        password: "employee-password",
      }),
    });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const { csrf_token } = (await login.json()) as { csrf_token: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": csrf_token, Origin: ORIGIN };

    // The login is not linked to an employee yet.
    expect((await fetchWorker("/v1/me/leave/balances", { headers })).status).toBe(404);

    const userRow = await env.DB.prepare("SELECT user_id FROM users WHERE tenant_id = ? AND email = ?")
      .bind(TENANT_ID, "staff@leavebalances.test")
      .first<{ user_id: string }>();
    const employee = await createEmployee("Self Balance Sofia", {
      start_date: "2020-01-01",
      user_id: userRow!.user_id,
    });
    const typeId = await annualTypeId();
    await assign(employee, typeId, await makePolicy(typeId, 14));

    const res = await fetchWorker("/v1/me/leave/balances?as_of=2026-06-01", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { employee_id: string; balances: LeaveBalance[] };
    expect(body.employee_id).toBe(employee);
    expect(body.balances.find((b) => b.leave_type_id === typeId)!.available_days).toBe(14);

    // The HR surface, with the same login, is still a 403.
    expect(
      (await fetchWorker(`/v1/people/leave/balances?employee_id=${employee}`, { headers })).status,
    ).toBe(403);
  });

  it("400s a bad as_of", async () => {
    const res = await fetchWorker("/v1/me/leave/balances?as_of=yesterday", { headers: bearer });
    expect(res.status).toBe(400);
  });
});

describe("tenant isolation", () => {
  it("404s a balance request for another tenant's employee", async () => {
    const res = await fetchWorker("/v1/people/leave/balances?employee_id=emp_from_elsewhere", {
      headers: bearer,
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "not_found" });
  });
});
