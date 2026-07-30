import type { Employee } from "../types";
import type { Entitlement, LeaveType, WorkCalendar } from "./types";

/**
 * The S6 seam — the ONLY file that knows leave policy might not be built yet.
 *
 * ## Why this file exists
 *
 * S7 (leave requests) depends on S6 (leave types, policies, entitlement,
 * public holidays, work weeks), and the two are being built concurrently from
 * the same `main`. S6's tables are not on this branch, so S7 cannot import them
 * — but S7 still has to ship something that runs, has correct balance
 * arithmetic, and is testable end to end.
 *
 * The split is drawn along PRD-006's own balance formula:
 *
 *     available = entitlement + carry_forward − taken − pending
 *                 └────── S6 owns ──────────┘   └── S7 owns ──┘
 *
 * `taken` and `pending` come from `leave_requests`, which S7 owns outright. So
 * the whole of S7's dependency on S6 is the three read functions below, and
 * every one of them falls back to a provisional default when S6's tables are
 * unreadable.
 *
 * ## How to reconcile when S6 lands
 *
 * Each function is `try { S6 query } catch { fallback }`. The catch is doing real
 * work in two distinct cases and both are expected:
 *
 *  1. **The table does not exist** (this branch, and any deploy where S6 has not
 *     migrated yet). D1 raises "no such table".
 *  2. **The table exists but the columns differ** from what is guessed below.
 *     S6 is being designed in parallel and its column names are not settled, so
 *     this file's queries are a best guess at PRD-006's wording, not a contract
 *     S6 agreed to.
 *
 * Case 2 is the one to fix on merge: run the leave tests, look for the
 * `[leave/policy-port]` warning, and correct the query. **Do not widen the catch
 * to hide a real error** — the warning is the signal that reconciliation is
 * outstanding, and `Entitlement.source` / `WorkCalendar.source` carry it all the
 * way out to the API so a console can say "policy not configured" instead of
 * presenting a guess as policy.
 *
 * Once S6 is merged and the queries are verified, the fallbacks can be deleted
 * outright — nothing else in the module references them.
 *
 * ## What the fallbacks deliberately do NOT do
 *
 * No tenure bands, no accrual methods, no pro-rating for mid-year joiners, no
 * carry-forward caps, no public holidays, no state variation, no configurable
 * work week, no statutory-minimum warnings. Every one of those is an S6
 * deliverable with its own acceptance criteria, and half-implementing them here
 * would give S6 two places to fix and this session a scope it was told to
 * time-box. The fallback is a floor that keeps S7 shippable alone, not a
 * shadow implementation of S6.
 */

/** D1 handle. Narrower than `Env` so the port stays trivially testable. */
interface PortDb {
  DB: D1Database;
}

/**
 * One warning per (tenant, concern) per isolate, so a fallback does not write a
 * log line on every request. Keyed by string rather than held per-call because
 * the point is to be noisy once and quiet afterwards.
 */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[leave/policy-port] ${message}`);
}

/**
 * PRD-006's seed list, as a floor.
 *
 * These mirror the seven types PRD-006 names — "annual, sick, hospitalisation,
 * maternity, paternity, unpaid, compassionate" — and its statement that they are
 * "all editable, none hardcoded". They are hardcoded HERE only because the table
 * that makes them editable is S6's; the moment `leave_types` is readable this
 * list stops being consulted.
 *
 * `requires_attachment` is set on the two medical types, which is the case
 * PRD-006 calls out ("for medical certificates"). `allows_negative_balance` is
 * true only for unpaid leave, whose whole point is having no entitlement to run
 * down.
 */
const FALLBACK_LEAVE_TYPES: readonly LeaveType[] = [
  {
    code: "annual",
    name: "Annual leave",
    paid: true,
    requires_attachment: false,
    max_consecutive_days: null,
    allows_half_day: true,
    allows_negative_balance: false,
  },
  {
    code: "sick",
    name: "Sick leave",
    paid: true,
    requires_attachment: true,
    max_consecutive_days: null,
    allows_half_day: true,
    allows_negative_balance: false,
  },
  {
    code: "hospitalisation",
    name: "Hospitalisation leave",
    paid: true,
    requires_attachment: true,
    max_consecutive_days: null,
    allows_half_day: false,
    allows_negative_balance: false,
  },
  {
    code: "maternity",
    name: "Maternity leave",
    paid: true,
    requires_attachment: false,
    max_consecutive_days: null,
    allows_half_day: false,
    allows_negative_balance: false,
  },
  {
    code: "paternity",
    name: "Paternity leave",
    paid: true,
    requires_attachment: false,
    max_consecutive_days: null,
    allows_half_day: false,
    allows_negative_balance: false,
  },
  {
    code: "unpaid",
    name: "Unpaid leave",
    paid: false,
    requires_attachment: false,
    max_consecutive_days: null,
    allows_half_day: true,
    // The stated exception to PRD-006's over-balance block.
    allows_negative_balance: true,
  },
  {
    code: "compassionate",
    name: "Compassionate leave",
    paid: true,
    requires_attachment: false,
    max_consecutive_days: 5,
    allows_half_day: false,
    allows_negative_balance: false,
  },
];

/**
 * Flat entitlement per type, with no tenure band and no pro-rating.
 *
 * The annual and sick figures are the Employment Act 1955 minimum for the
 * shortest tenure band, and PRD-006 is explicit that statutory minimums are "a
 * seed default and a warning, not an enforced floor". They are a starting point
 * for a tenant to edit, not compliance guidance — PRD-006's own open question
 * asks for these to be confirmed against the post-2022 amendments before
 * seeding, and that confirmation belongs to S6 with the seed data, not here.
 */
const FALLBACK_ENTITLEMENT_DAYS: Record<string, number> = {
  annual: 8,
  sick: 14,
  hospitalisation: 60,
  maternity: 98,
  paternity: 7,
  compassionate: 3,
  // Unpaid leave has no entitlement by definition; `allows_negative_balance`
  // is what makes it requestable.
  unpaid: 0,
};

/** Mon–Fri. PRD-006's stated default, and S6 owns making it configurable. */
const FALLBACK_WORK_DAYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);

/**
 * The tenant's leave types.
 *
 * Ordered by code so the console's dropdown and the balances list are stable
 * across calls — an unordered leave-type list would reshuffle the employee's
 * form on every render.
 */
export async function getLeaveTypes(env: PortDb, tenantId: string): Promise<LeaveType[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT code, name, paid, requires_attachment, max_consecutive_days,
              allows_half_day, allows_negative_balance
         FROM leave_types
        WHERE tenant_id = ?
        ORDER BY code ASC`,
    )
      .bind(tenantId)
      .all<{
        code: string;
        name: string;
        paid: number;
        requires_attachment: number;
        max_consecutive_days: number | null;
        allows_half_day: number;
        allows_negative_balance: number | null;
      }>();

    // An empty table is not a reason to fall back: a tenant that deleted every
    // leave type has said something, and inventing seven types over the top of
    // that would be worse than an empty list. A MISSING table throws instead,
    // and that is the case the catch handles.
    return (results ?? []).map((row) => ({
      code: row.code,
      name: row.name,
      paid: row.paid !== 0,
      requires_attachment: row.requires_attachment !== 0,
      max_consecutive_days: row.max_consecutive_days,
      allows_half_day: row.allows_half_day !== 0,
      // S6 may not carry this column — PRD-006 lists it only as the exception
      // clause on the over-balance criterion, not as a `leave_types` field. A
      // NULL reads as false, which is the safe direction: leave that cannot go
      // negative is blocked rather than silently allowed.
      allows_negative_balance: (row.allows_negative_balance ?? 0) !== 0,
    }));
  } catch (err) {
    warnOnce(
      `types:${tenantId}`,
      `leave_types unreadable, using provisional defaults (S6 not merged, or its columns differ): ${String(err)}`,
    );
    return [...FALLBACK_LEAVE_TYPES];
  }
}

/** One leave type by code, or null when the tenant has no such type. */
export async function getLeaveType(
  env: PortDb,
  tenantId: string,
  code: string,
): Promise<LeaveType | null> {
  const types = await getLeaveTypes(env, tenantId);
  return types.find((t) => t.code === code) ?? null;
}

/**
 * Entitlement for one employee, one leave type, one calendar year.
 *
 * S6 owns everything interesting about this number: which policy the employee is
 * assigned to, their tenure band, the accrual method, pro-rating for a mid-year
 * join or leave, and the carry-forward cap. The fallback is flat.
 */
export async function getEntitlement(
  env: PortDb,
  tenantId: string,
  employee: Pick<Employee, "employee_id" | "employment_type" | "start_date">,
  leaveTypeCode: string,
  year: number,
): Promise<Entitlement> {
  try {
    // Best guess at PRD-006's wording: a policy carries entitlement by
    // employment type and tenure band, an employee is assigned to one, and S6
    // resolves the assignment. Reading a pre-computed `leave_balances` row would
    // be wrong here — PRD-006 says that table is DERIVED, and deriving it needs
    // the `taken`/`pending` halves that only S7 has.
    const row = await env.DB.prepare(
      `SELECT entitlement_days, carry_forward_days
         FROM leave_balances
        WHERE tenant_id = ? AND employee_id = ? AND leave_type_code = ? AND year = ?`,
    )
      .bind(tenantId, employee.employee_id, leaveTypeCode, year)
      .first<{ entitlement_days: number; carry_forward_days: number | null }>();

    if (row) {
      return {
        days: row.entitlement_days,
        carry_forward_days: row.carry_forward_days ?? 0,
        source: "policy",
      };
    }
    // Table readable but no row for this employee/type/year. S6 has landed and
    // simply has nothing to say here (a type the employee's policy does not
    // grant), so zero is the honest answer rather than the fallback figure.
    return { days: 0, carry_forward_days: 0, source: "policy" };
  } catch (err) {
    warnOnce(
      `entitlement:${tenantId}`,
      `leave_balances unreadable, using flat provisional entitlement with no tenure band, ` +
        `accrual or pro-rating (S6 not merged, or its columns differ): ${String(err)}`,
    );
    return {
      days: FALLBACK_ENTITLEMENT_DAYS[leaveTypeCode] ?? 0,
      carry_forward_days: 0,
      source: "default",
    };
  }
}

/**
 * The working-day calendar for one employee in one year.
 *
 * Two S6 concerns in one call because they are always needed together and
 * always for the same employee: the configurable work week, and the public
 * holidays for that employee's state. `employees.location` is the only
 * state-ish field the People module has today, so it is what gets matched
 * against holiday scope — S6 may well introduce a dedicated work-location
 * column, and if so this is the query to update.
 */
export async function getWorkCalendar(
  env: PortDb,
  tenantId: string,
  employee: Pick<Employee, "employee_id" | "location">,
  year: number,
): Promise<WorkCalendar> {
  let workDays: ReadonlySet<number> | null = null;
  let holidays: Set<string> | null = null;
  let degraded = false;

  try {
    const row = await env.DB.prepare(
      `SELECT work_days FROM leave_work_weeks WHERE tenant_id = ?`,
    )
      .bind(tenantId)
      .first<{ work_days: string }>();
    // Stored as a compact day-number list ("1,2,3,4,5"), which is the shape a
    // Sun–Thu week ("0,1,2,3,4") needs just as cheaply as Mon–Fri.
    if (row?.work_days) {
      const parsed = row.work_days
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      if (parsed.length > 0) workDays = new Set(parsed);
    }
  } catch {
    degraded = true;
  }

  try {
    // National holidays always apply; a state-scoped one applies only when it
    // matches the employee's location. Tenant overrides are S6's to model — if
    // it adds an `active`/`deleted` flag, this is where it is filtered.
    const { results } = await env.DB.prepare(
      `SELECT holiday_date
         FROM public_holidays
        WHERE tenant_id = ?
          AND holiday_date >= ? AND holiday_date <= ?
          AND (scope = 'national' OR scope = ?)`,
    )
      .bind(tenantId, `${year}-01-01`, `${year}-12-31`, employee.location ?? " ")
      .all<{ holiday_date: string }>();
    holidays = new Set((results ?? []).map((r) => r.holiday_date));
  } catch {
    degraded = true;
  }

  if (degraded) {
    warnOnce(
      `calendar:${tenantId}`,
      `work week and/or public_holidays unreadable, counting Mon–Fri with NO public holidays ` +
        `(S6 not merged, or its columns differ). State-varying holidays are an S6 deliverable.`,
    );
  }

  return {
    workDays: workDays ?? FALLBACK_WORK_DAYS,
    holidays: holidays ?? new Set<string>(),
    source: degraded ? "default" : "policy",
  };
}

/** Exported for the port's own tests, and so the fallback is assertable. */
export const PROVISIONAL_DEFAULTS = {
  leaveTypes: FALLBACK_LEAVE_TYPES,
  entitlementDays: FALLBACK_ENTITLEMENT_DAYS,
  workDays: FALLBACK_WORK_DAYS,
} as const;
