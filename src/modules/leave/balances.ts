import { ulid } from "../../lib/ulid";
import {
  addDays,
  endOfYear,
  monthsOfService,
  monthOf,
  roundHalfDay,
  startOfYear,
  toIso,
  yearOf,
} from "./dates";
import { effectiveHolidays, getLeaveSettings, getLeaveProfile, listLeaveTypes } from "./service";
import { countWorkingDays } from "./workdays";
import type { HolidaySet } from "./holidays/resolve";
import {
  LeaveError,
  type AccrualMethod,
  type CarryForwardResult,
  type EffectiveHoliday,
  type EmploymentType,
  type LeaveBalance,
  type LeaveType,
  type PolicyBand,
  type WorkWeek,
} from "./types";

/**
 * Leave balances (PRD-006b).
 *
 * PRD-006's success metric is blunt about why this file exists: *"Leave balance
 * correctness across mid-year joins, carry-forward, and state holidays is
 * covered by tests, because a wrong balance destroys trust permanently."*
 *
 * The formula, once:
 *
 *     available = entitlement + carried-forward + adjustments − taken − pending
 *
 * Four properties of it are load-bearing and each is a test:
 *
 *  - **Nothing is stored.** A balance is recomputed on every read from the
 *    policy, the employee's dates and their requests. There is no counter to
 *    drift out of step with reality, and correcting a mis-approved request
 *    fixes the balance by construction.
 *  - **Pending counts.** A submitted-but-undecided request reduces the
 *    available balance immediately, or employees over-book against days they
 *    have already asked for.
 *  - **Rejection restores.** It follows from the above rather than needing its
 *    own code path: `taken` and `pending` only count `approved` and `pending`
 *    rows, so a rejected or cancelled request is simply not in the sum.
 *  - **Carried days are consumed first.** Otherwise an expiry rule would eat
 *    the current year's entitlement instead of the leftovers it is meant to.
 *
 * Two deliberate conventions, both of which stop a balance moving on a day
 * nothing happened:
 *
 *  - The **tenure band is evaluated at the end of the leave period**, not at
 *    the moment of the query. An employee who crosses two years' service in
 *    August is on the 12-day band for the whole of that year, rather than
 *    watching their entitlement jump mid-year.
 *  - **Pro-rating counts whole calendar months, joining and leaving month
 *    inclusive.** A 1 July joiner on a 14-day entitlement gets 7 — which is
 *    PRD-006's own acceptance criterion.
 */

interface EmployeeRow {
  employee_id: string;
  employment_type: EmploymentType;
  start_date: string | null;
  end_date: string | null;
  status: string;
}

interface PolicyResolution {
  policy_id: string;
  accrual_method: AccrualMethod;
  carry_forward_max_days: number;
  carry_forward_expiry_months: number | null;
  entitlement_days_override: number | null;
  bands: PolicyBand[];
}

/** The leave period a balance is measured over. */
interface Period {
  start: string;
  end: string;
  /** The integer key adjustments and carry-forward rows are filed under. */
  leaveYear: number;
}

async function loadEmployee(
  db: D1Database,
  tenantId: string,
  employeeId: string,
): Promise<EmployeeRow> {
  const row = await db
    .prepare(
      `SELECT employee_id, employment_type, start_date, end_date, status
       FROM employees WHERE tenant_id = ? AND employee_id = ?`,
    )
    .bind(tenantId, employeeId)
    .first<EmployeeRow>();
  if (!row) throw new LeaveError("not_found", "employee not found", 404);
  return row;
}

/**
 * Which policy applies to this employee for this leave type.
 *
 * An explicit assignment wins; otherwise the leave type's default policy. The
 * fallback is what makes the seeded Malaysian defaults immediately useful —
 * without it, a freshly onboarded tenant would show every employee a zero
 * balance until HR clicked through the whole directory.
 */
async function resolvePolicies(
  db: D1Database,
  tenantId: string,
  employeeId: string,
): Promise<Map<string, PolicyResolution>> {
  const { results } = await db
    .prepare(
      `SELECT t.leave_type_id                       AS leave_type_id,
              COALESCE(a.policy_id, d.policy_id)    AS policy_id,
              COALESCE(ap.accrual_method, d.accrual_method) AS accrual_method,
              COALESCE(ap.carry_forward_max_days, d.carry_forward_max_days) AS carry_forward_max_days,
              COALESCE(ap.carry_forward_expiry_months, d.carry_forward_expiry_months)
                                                    AS carry_forward_expiry_months,
              a.entitlement_days_override           AS entitlement_days_override
       FROM leave_types t
       LEFT JOIN employee_leave_assignments a
              ON a.tenant_id = t.tenant_id AND a.leave_type_id = t.leave_type_id
             AND a.employee_id = ?
       LEFT JOIN leave_policies ap
              ON ap.tenant_id = t.tenant_id AND ap.policy_id = a.policy_id
       LEFT JOIN leave_policies d
              ON d.tenant_id = t.tenant_id AND d.leave_type_id = t.leave_type_id
             AND d.is_default = 1 AND d.archived_at IS NULL
       WHERE t.tenant_id = ? AND t.archived_at IS NULL`,
    )
    .bind(employeeId, tenantId)
    .all<{
      leave_type_id: string;
      policy_id: string | null;
      accrual_method: AccrualMethod | null;
      carry_forward_max_days: number | null;
      carry_forward_expiry_months: number | null;
      entitlement_days_override: number | null;
    }>();

  const policyIds = results.map((r) => r.policy_id).filter((id): id is string => id !== null);
  const bands = await loadBands(db, tenantId, policyIds);

  const byType = new Map<string, PolicyResolution>();
  for (const row of results) {
    if (!row.policy_id) continue;
    byType.set(row.leave_type_id, {
      policy_id: row.policy_id,
      accrual_method: row.accrual_method ?? "annual_upfront",
      carry_forward_max_days: row.carry_forward_max_days ?? 0,
      carry_forward_expiry_months: row.carry_forward_expiry_months,
      entitlement_days_override: row.entitlement_days_override,
      bands: bands.get(row.policy_id) ?? [],
    });
  }
  return byType;
}

async function loadBands(
  db: D1Database,
  tenantId: string,
  policyIds: readonly string[],
): Promise<Map<string, PolicyBand[]>> {
  const out = new Map<string, PolicyBand[]>();
  const unique = [...new Set(policyIds)];
  if (unique.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT policy_id, band_id, employment_type, min_months_service, max_months_service,
              entitlement_days
       FROM leave_policy_bands WHERE tenant_id = ? AND policy_id IN (${unique.map(() => "?").join(", ")})
       ORDER BY min_months_service`,
    )
    .bind(tenantId, ...unique)
    .all<PolicyBand & { policy_id: string }>();
  for (const { policy_id, ...band } of results) {
    out.set(policy_id, [...(out.get(policy_id) ?? []), band]);
  }
  return out;
}

/**
 * Pick the entitlement band.
 *
 * A band naming the employee's employment type beats a band that applies to
 * everyone, so "12 days for all, 8 for interns" is two rows rather than one per
 * type. Within the same specificity the tenure window decides; if no window
 * contains the employee's tenure, the highest band they have passed applies,
 * which is the sane reading of a policy whose bands stop short.
 */
export function selectBand(
  bands: readonly PolicyBand[],
  employmentType: EmploymentType,
  months: number,
): PolicyBand | null {
  const typed = bands.filter((b) => b.employment_type === employmentType);
  const generic = bands.filter((b) => b.employment_type === null);
  for (const set of [typed, generic]) {
    if (set.length === 0) continue;
    const inWindow = set.find(
      (b) =>
        months >= b.min_months_service &&
        (b.max_months_service === null || months < b.max_months_service),
    );
    if (inWindow) return inWindow;
    const passed = set
      .filter((b) => months >= b.min_months_service)
      .sort((a, b) => b.min_months_service - a.min_months_service)[0];
    if (passed) return passed;
  }
  return null;
}

/** The leave period for a policy. Calendar year, except `on_anniversary`,
 * where the year runs from the employee's start date. */
export function periodFor(
  accrualMethod: AccrualMethod,
  asOf: string,
  startDate: string | null,
): Period {
  if (accrualMethod !== "on_anniversary" || !startDate) {
    const year = yearOf(asOf);
    return { start: startOfYear(year), end: endOfYear(year), leaveYear: year };
  }
  // The anniversary on or before `asOf`, and the day before the next one.
  const startMonthDay = startDate.slice(5);
  const asOfYear = yearOf(asOf);
  const thisYearAnniversary = `${asOfYear}-${startMonthDay}`;
  const periodStart =
    asOf >= thisYearAnniversary ? thisYearAnniversary : `${asOfYear - 1}-${startMonthDay}`;
  const nextAnniversary = `${yearOf(periodStart) + 1}-${startMonthDay}`;
  return {
    start: periodStart < startDate ? startDate : periodStart,
    end: addDays(nextAnniversary, -1),
    leaveYear: yearOf(periodStart),
  };
}

/**
 * Whole calendar months the employee is employed within the period, joining
 * and leaving month inclusive — the pro-rating denominator's numerator.
 * A full year is 12; a 1 July joiner on a calendar year is 6.
 */
export function activeMonths(period: Period, employee: EmployeeRow): number {
  const joined = employee.start_date;
  const left = employee.end_date;
  if (joined && joined > period.end) return 0;
  if (left && left < period.start) return 0;

  const firstMonth = joined && joined > period.start ? monthIndex(period, joined) : 0;
  const lastMonth = left && left < period.end ? monthIndex(period, left) : totalMonths(period) - 1;
  return Math.max(0, lastMonth - firstMonth + 1);
}

/** Months from the period start to `date`, 0-based. */
function monthIndex(period: Period, date: string): number {
  const startY = yearOf(period.start);
  const startM = monthOf(period.start);
  return (yearOf(date) - startY) * 12 + (monthOf(date) - startM);
}

function totalMonths(period: Period): number {
  return monthIndex(period, period.end) + 1;
}

/** Months of the active window that have fully elapsed by `asOf`. */
function elapsedMonths(period: Period, employee: EmployeeRow, asOf: string): number {
  const active = activeMonths(period, employee);
  if (active === 0) return 0;
  const joined = employee.start_date;
  const firstMonth = joined && joined > period.start ? monthIndex(period, joined) : 0;
  // A month counts once it is behind us: the month containing `asOf` has not
  // finished accruing yet.
  const asOfMonth = asOf > period.end ? totalMonths(period) : monthIndex(period, asOf);
  return Math.max(0, Math.min(active, asOfMonth - firstMonth));
}

/**
 * Entitlement for the period, pro-rated for a partial year and accrued to
 * `asOf` according to the policy's accrual method.
 */
export function accruedEntitlement(
  fullEntitlement: number,
  accrualMethod: AccrualMethod,
  period: Period,
  employee: EmployeeRow,
  asOf: string,
): number {
  const active = activeMonths(period, employee);
  if (active === 0) return 0;

  switch (accrualMethod) {
    case "annual_upfront":
      // Granted in full at the start of the period, pro-rated only for a
      // partial year. 14 days, joined 1 July → 14 × 6/12 → 7.
      return roundHalfDay((fullEntitlement * active) / 12);
    case "monthly_accrual": {
      // Earned month by month, so it grows through the year.
      const elapsed = elapsedMonths(period, employee, asOf);
      return roundHalfDay((fullEntitlement * elapsed) / 12);
    }
    case "on_anniversary":
      // The period already starts at the anniversary, so the full entitlement
      // is granted on day one of it — no pro-rating to do.
      return roundHalfDay(fullEntitlement);
  }
}

interface RequestRow {
  leave_type_id: string;
  start_date: string;
  end_date: string;
  start_half_day: number;
  end_half_day: number;
  working_days: number;
  state: string;
}

/**
 * Days consumed within the period, split by request state.
 *
 * A request wholly inside the period contributes its stored `working_days` —
 * the number computed when it was submitted, so a later holiday correction
 * cannot silently restate an approved request. A request straddling the period
 * boundary is recounted for the overlapping part only, because charging a
 * Boxing-Day-to-2-January break entirely to the old year would be wrong in
 * both years.
 */
async function consumedDays(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  period: Period,
  workWeek: WorkWeek,
  holidaysByYear: Map<number, HolidaySet>,
): Promise<Map<string, { taken: number; pending: number; takenBefore: (date: string) => number }>> {
  const { results } = await db
    .prepare(
      `SELECT leave_type_id, start_date, end_date, start_half_day, end_half_day, working_days, state
       FROM leave_requests
       WHERE tenant_id = ? AND employee_id = ? AND state IN ('pending', 'approved')
         AND end_date >= ? AND start_date <= ?`,
    )
    .bind(tenantId, employeeId, period.start, period.end)
    .all<RequestRow>();

  const out = new Map<
    string,
    { taken: number; pending: number; takenBefore: (date: string) => number }
  >();
  const approvedByType = new Map<string, { start: string; days: number }[]>();

  for (const row of results) {
    const days = daysInPeriod(row, period, workWeek, holidaysByYear);
    if (days === 0) continue;
    const entry = out.get(row.leave_type_id) ?? {
      taken: 0,
      pending: 0,
      takenBefore: () => 0,
    };
    if (row.state === "approved") {
      entry.taken += days;
      approvedByType.set(row.leave_type_id, [
        ...(approvedByType.get(row.leave_type_id) ?? []),
        { start: row.start_date, days },
      ]);
    } else {
      entry.pending += days;
    }
    out.set(row.leave_type_id, entry);
  }

  // Close over the approved runs so the carry-forward expiry rule can ask
  // "how much had they taken before the carried days lapsed?".
  for (const [typeId, entry] of out) {
    const runs = approvedByType.get(typeId) ?? [];
    entry.takenBefore = (date: string) =>
      runs.filter((r) => r.start < date).reduce((sum, r) => sum + r.days, 0);
    out.set(typeId, entry);
  }
  return out;
}

function daysInPeriod(
  row: RequestRow,
  period: Period,
  workWeek: WorkWeek,
  holidaysByYear: Map<number, HolidaySet>,
): number {
  if (row.start_date >= period.start && row.end_date <= period.end) return row.working_days;

  const from = row.start_date > period.start ? row.start_date : period.start;
  const to = row.end_date < period.end ? row.end_date : period.end;
  if (to < from) return 0;
  const holidays = mergeYears(holidaysByYear, yearOf(from), yearOf(to));
  return countWorkingDays(from, to, workWeek, holidays, {
    // Half days only survive the clip if their own boundary day did.
    start_half_day: row.start_half_day === 1 && from === row.start_date,
    end_half_day: row.end_half_day === 1 && to === row.end_date,
  }).working_days;
}

function mergeYears(byYear: Map<number, HolidaySet>, from: number, to: number): HolidaySet {
  const byDate = new Map<string, EffectiveHoliday>();
  let dataAvailable = true;
  let provisional = false;
  for (let y = from; y <= to; y += 1) {
    const set = byYear.get(y);
    if (!set) {
      dataAvailable = false;
      continue;
    }
    dataAvailable = dataAvailable && set.dataAvailable;
    provisional = provisional || set.provisional;
    for (const [date, h] of set.byDate) byDate.set(date, h);
  }
  return { byDate, dataAvailable, provisional, sourceNote: null };
}

async function adjustmentsFor(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  leaveYear: number,
): Promise<Map<string, { carried: number; other: number }>> {
  const { results } = await db
    .prepare(
      `SELECT leave_type_id, kind, SUM(days) AS days
       FROM leave_balance_adjustments
       WHERE tenant_id = ? AND employee_id = ? AND leave_year = ?
       GROUP BY leave_type_id, kind`,
    )
    .bind(tenantId, employeeId, leaveYear)
    .all<{ leave_type_id: string; kind: string; days: number }>();

  const out = new Map<string, { carried: number; other: number }>();
  for (const row of results) {
    const entry = out.get(row.leave_type_id) ?? { carried: 0, other: 0 };
    if (row.kind === "carry_forward") entry.carried += row.days;
    else entry.other += row.days;
    out.set(row.leave_type_id, entry);
  }
  return out;
}

/** Two decimal places — half days survive, float dust does not. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface BalanceOptions {
  /** Defaults to today (UTC). */
  as_of?: string;
  /** Restrict to one leave type. */
  leave_type_id?: string;
}

export interface BalanceResult {
  employee_id: string;
  as_of: string;
  balances: LeaveBalance[];
  /** True when a year in scope has no shipped holiday data — the counts are
   * still returned, but the caller must be able to say so. */
  holiday_data_available: boolean;
  holiday_data_provisional: boolean;
}

export async function getBalances(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  options: BalanceOptions = {},
): Promise<BalanceResult> {
  const asOf = options.as_of ?? toIso(Date.now());
  const employee = await loadEmployee(db, tenantId, employeeId);
  const [types, policies, settings, profile] = await Promise.all([
    listLeaveTypes(db, tenantId),
    resolvePolicies(db, tenantId, employeeId),
    getLeaveSettings(db, tenantId),
    getLeaveProfile(db, tenantId, employeeId),
  ]);

  const workWeek = profile.work_week ?? settings.work_week;
  const selected = options.leave_type_id
    ? types.filter((t) => t.leave_type_id === options.leave_type_id)
    : types;

  // Every period any policy might use, so holidays are loaded once rather than
  // once per leave type.
  const periods = new Map<string, Period>();
  for (const type of selected) {
    const policy = policies.get(type.leave_type_id);
    periods.set(
      type.leave_type_id,
      periodFor(policy?.accrual_method ?? "annual_upfront", asOf, employee.start_date),
    );
  }
  const years = new Set<number>();
  for (const period of periods.values()) {
    for (let y = yearOf(period.start); y <= yearOf(period.end); y += 1) years.add(y);
  }
  const holidaysByYear = await effectiveHolidays(db, tenantId, profile.work_state, [...years]);

  const balances: LeaveBalance[] = [];
  for (const type of selected) {
    const period = periods.get(type.leave_type_id)!;
    const [consumed, adjustments] = await Promise.all([
      consumedDays(db, tenantId, employeeId, period, workWeek, holidaysByYear),
      adjustmentsFor(db, tenantId, employeeId, period.leaveYear),
    ]);
    balances.push(
      buildBalance({
        type,
        policy: policies.get(type.leave_type_id) ?? null,
        period,
        employee,
        asOf,
        consumed: consumed.get(type.leave_type_id) ?? {
          taken: 0,
          pending: 0,
          takenBefore: () => 0,
        },
        adjustment: adjustments.get(type.leave_type_id) ?? { carried: 0, other: 0 },
      }),
    );
  }

  const sets = [...holidaysByYear.values()];
  return {
    employee_id: employeeId,
    as_of: asOf,
    balances,
    holiday_data_available: sets.every((s) => s.dataAvailable),
    holiday_data_provisional: sets.some((s) => s.provisional),
  };
}

interface BuildBalanceInput {
  type: LeaveType;
  policy: PolicyResolution | null;
  period: Period;
  employee: EmployeeRow;
  asOf: string;
  consumed: { taken: number; pending: number; takenBefore: (date: string) => number };
  adjustment: { carried: number; other: number };
}

function buildBalance(input: BuildBalanceInput): LeaveBalance {
  const { type, policy, period, employee, asOf, consumed, adjustment } = input;

  const bandMonths = monthsOfService(
    employee.start_date ?? period.start,
    // Tenure is read at the end of the period the employee is actually there
    // for, so an entitlement does not step up mid-year.
    employee.end_date && employee.end_date < period.end ? employee.end_date : period.end,
  );

  let fullEntitlement = 0;
  let entitlement = 0;
  if (policy) {
    const band = selectBand(policy.bands, employee.employment_type, bandMonths);
    fullEntitlement = policy.entitlement_days_override ?? band?.entitlement_days ?? 0;
    entitlement = accruedEntitlement(
      fullEntitlement,
      policy.accrual_method,
      period,
      employee,
      asOf,
    );
  }

  // Carried days are spent before this year's entitlement, so an expiry rule
  // lapses the leftovers rather than eating the current year.
  let carried = adjustment.carried;
  let expired = 0;
  if (policy?.carry_forward_expiry_months && carried > 0) {
    const expiryDate = addMonths(period.start, policy.carry_forward_expiry_months);
    if (asOf >= expiryDate) {
      const usedBeforeExpiry = Math.min(carried, consumed.takenBefore(expiryDate));
      expired = round2(carried - usedBeforeExpiry);
      carried = round2(usedBeforeExpiry);
    }
  }

  const available =
    entitlement + carried + adjustment.other - consumed.taken - consumed.pending;

  return {
    leave_type_id: type.leave_type_id,
    leave_type_code: type.code,
    leave_type_name: type.name,
    leave_year: period.leaveYear,
    period_start: period.start,
    period_end: period.end,
    policy_id: policy?.policy_id ?? null,
    accrual_method: policy?.accrual_method ?? null,
    full_entitlement_days: round2(fullEntitlement),
    entitlement_days: round2(entitlement),
    carried_forward_days: round2(carried),
    carry_forward_expired_days: expired,
    adjustment_days: round2(adjustment.other),
    taken_days: round2(consumed.taken),
    pending_days: round2(consumed.pending),
    available_days: round2(available),
    unconfigured: policy === null,
  };
}

/** Month arithmetic that clamps rather than rolling over: 31 January + 1 month
 * is the end of February, not the 3rd of March. */
function addMonths(iso: string, months: number): string {
  const year = yearOf(iso);
  const month = monthOf(iso) - 1 + months;
  const day = Number(iso.slice(8, 10));
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return toIso(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
}

// ---- Year close --------------------------------------------------------

export interface YearCloseOptions {
  /** The year being closed. Carried days land in `leave_year + 1`. */
  leave_year: number;
  /** Restrict to one employee; otherwise every active employee. */
  employee_id?: string;
  /** Preview without writing. */
  dry_run?: boolean;
  created_by?: string | null;
}

/**
 * Close a leave year: work out what each employee carries into the next one and
 * record it.
 *
 * Carry-forward is the one part of a balance that cannot be recomputed later —
 * it depends on the cap as it stood at close — so it is written down as an
 * adjustment row rather than derived. The row is `INSERT OR IGNORE` against a
 * partial unique index, so running the close twice is a no-op rather than
 * double-crediting everybody. Only types with `carry_forward_allowed` and a
 * policy cap above zero produce a row.
 *
 * Unused days are measured **after** pending requests, so days already asked
 * for are not carried and then spent twice.
 */
export async function closeLeaveYear(
  db: D1Database,
  tenantId: string,
  options: YearCloseOptions,
): Promise<CarryForwardResult[]> {
  const { leave_year: year } = options;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new LeaveError("invalid_request", "leave_year must be a four-digit year", 400);
  }

  const employees = await listCloseCandidates(db, tenantId, options.employee_id);
  const types = await listLeaveTypes(db, tenantId);
  const carryable = new Set(
    types.filter((t) => t.carry_forward_allowed).map((t) => t.leave_type_id),
  );
  if (carryable.size === 0) return [];

  // Which (employee, type) pairs already carry into next year. Read up front so
  // a re-run reports "already closed" honestly rather than claiming to have
  // written rows the unique index silently dropped.
  const alreadyCarried = await existingCarryForward(db, tenantId, year + 1);

  const results: CarryForwardResult[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const employeeId of employees) {
    // Measured at the last day of the year being closed.
    const { balances } = await getBalances(db, tenantId, employeeId, {
      as_of: endOfYear(year),
    });
    for (const balance of balances) {
      if (!carryable.has(balance.leave_type_id)) continue;
      if (balance.leave_year !== year) continue; // an anniversary policy mid-cycle
      const policy = await policyCap(db, tenantId, balance.policy_id);
      if (policy <= 0) continue;

      const unused = Math.max(0, balance.available_days);
      const carried = roundHalfDay(Math.min(unused, policy));
      const already = alreadyCarried.has(`${employeeId}|${balance.leave_type_id}`);
      results.push({
        employee_id: employeeId,
        leave_type_id: balance.leave_type_id,
        unused_days: round2(unused),
        carried_days: carried,
        cap_days: policy,
        capped: unused > policy,
        written: !options.dry_run && carried > 0 && !already,
      });
      if (options.dry_run || carried <= 0 || already) continue;

      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO leave_balance_adjustments (
               adjustment_id, tenant_id, employee_id, leave_type_id, leave_year, days, kind,
               note, created_by
             ) VALUES (?, ?, ?, ?, ?, ?, 'carry_forward', ?, ?)`,
          )
          .bind(
            `lva_${ulid()}`,
            tenantId,
            employeeId,
            balance.leave_type_id,
            year + 1,
            carried,
            `Carried forward from ${year}${unused > policy ? ` (capped at ${policy} of ${round2(unused)} unused)` : ""}`,
            options.created_by ?? null,
          ),
      );
    }
  }

  if (statements.length > 0) await db.batch(statements);
  return results;
}

async function existingCarryForward(
  db: D1Database,
  tenantId: string,
  intoYear: number,
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT employee_id, leave_type_id FROM leave_balance_adjustments
       WHERE tenant_id = ? AND leave_year = ? AND kind = 'carry_forward'`,
    )
    .bind(tenantId, intoYear)
    .all<{ employee_id: string; leave_type_id: string }>();
  return new Set(results.map((r) => `${r.employee_id}|${r.leave_type_id}`));
}

async function listCloseCandidates(
  db: D1Database,
  tenantId: string,
  employeeId?: string,
): Promise<string[]> {
  if (employeeId) return [employeeId];
  const { results } = await db
    .prepare(
      "SELECT employee_id FROM employees WHERE tenant_id = ? AND status = 'active' ORDER BY employee_id",
    )
    .bind(tenantId)
    .all<{ employee_id: string }>();
  return results.map((r) => r.employee_id);
}

async function policyCap(
  db: D1Database,
  tenantId: string,
  policyId: string | null,
): Promise<number> {
  // Nothing configured carries nothing.
  if (!policyId) return 0;
  const row = await db
    .prepare("SELECT carry_forward_max_days FROM leave_policies WHERE tenant_id = ? AND policy_id = ?")
    .bind(tenantId, policyId)
    .first<{ carry_forward_max_days: number }>();
  return row?.carry_forward_max_days ?? 0;
}

/** A manual balance correction — the escape hatch every leave system needs. */
export async function addAdjustment(
  db: D1Database,
  tenantId: string,
  input: {
    employee_id: string;
    leave_type_id: string;
    leave_year: number;
    days: number;
    kind?: "adjustment" | "encashment";
    note?: string | null;
    created_by?: string | null;
  },
): Promise<{ adjustment_id: string }> {
  const id = `lva_${ulid()}`;
  await db
    .prepare(
      `INSERT INTO leave_balance_adjustments (
         adjustment_id, tenant_id, employee_id, leave_type_id, leave_year, days, kind, note, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      input.employee_id,
      input.leave_type_id,
      input.leave_year,
      input.days,
      input.kind ?? "adjustment",
      input.note ?? null,
      input.created_by ?? null,
    )
    .run();
  return { adjustment_id: id };
}
