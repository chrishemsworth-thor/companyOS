import { getBalances as getS6Balances } from "../../leave/balances";
import {
  effectiveHolidays,
  getLeaveProfile as getS6Profile,
  getLeaveSettings as getS6Settings,
  listLeaveTypes as listS6LeaveTypes,
} from "../../leave/service";
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
    // S6's own read path, not a raw SELECT. That matters for more than tidiness:
    // `listLeaveTypes` seeds the Malaysian defaults on first touch for a tenant
    // that has never opened a leave screen, and reading the table directly
    // sidesteps that. It did, and the result was worse than either behaviour on
    // its own — the first call of a request saw an empty table and served
    // provisional types, a later call in the same request saw the seeded ones,
    // and the two disagreed about how many days the employee had.
    const types = await listS6LeaveTypes(env.DB, tenantId);

    // An empty list here is now a real statement rather than an unconfigured
    // tenant: seeding has run, so the tenant has archived or deleted every type
    // it was given. Inventing seven over the top of that would be worse than an
    // empty list.
    return types.map((row) => ({
      code: row.code,
      name: row.name,
      paid: row.is_paid,
      requires_attachment: row.requires_attachment,
      max_consecutive_days: row.max_consecutive_days,
      allows_half_day: row.allows_half_day,
      allows_negative_balance: row.allow_negative_balance,
    }));
  } catch (err) {
    warnOnce(
      `types:${tenantId}`,
      `leave_types unreadable, using provisional defaults (S6 not migrated): ${String(err)}`,
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
 *
 * **Reconciled with S6.** The guess this file shipped with — a pre-computed
 * `leave_balances` table — was wrong in the way the header predicted: S6 has no
 * such table, because entitlement is *derived* there too. So this calls S6's
 * engine directly rather than reading a table, and takes only the entitlement
 * half of its answer. `taken` and `pending` are deliberately discarded: S6
 * computes them from `leave_requests` exactly as this module does, and using
 * both would double-count every day of leave.
 */
export async function getEntitlement(
  env: PortDb,
  tenantId: string,
  employee: Pick<Employee, "employee_id" | "employment_type" | "start_date">,
  leaveTypeCode: string,
  year: number,
): Promise<Entitlement> {
  try {
    // Accrual is evaluated at a date, not a year: a monthly-accrual policy has
    // granted less in March than it will in December. For the current year that
    // date is today (S6's own default); for a past or future year the only
    // meaningful point is its end, when the year's entitlement is whole.
    const currentYear = new Date().getUTCFullYear();
    const asOf = year === currentYear ? undefined : `${year}-12-31`;

    const result = await getS6Balances(env.DB, tenantId, employee.employee_id, { as_of: asOf });
    const balance = result.balances.find((b) => b.leave_type_code === leaveTypeCode);

    // S6 distinguishes "configured, and the answer is zero" from "nothing is
    // configured for this type" — its own words: *"the balance is zero because
    // nothing is configured, which is a different thing from a zero balance"*.
    // That second case is precisely what this port's provisional defaults are
    // for, so it is routed to them rather than taken at face value. Taking it
    // literally is what made every leave request fail with "short by 3" against
    // a freshly seeded tenant that has types but no policies yet.
    if (balance && !balance.unconfigured) {
      return {
        // Adjustments are part of what the employee may take — an HR encashment
        // or a goodwill day is not carry-forward and not accrual, but leaving it
        // out would make this module's balance disagree with the one HR sees on
        // S6's own screen.
        days: balance.entitlement_days + balance.adjustment_days,
        carry_forward_days: balance.carried_forward_days,
        source: "policy",
      };
    }
    // Either S6 has no such type at all, or it has one with no policy behind
    // it. Both mean the same thing to a filer — nothing has been configured —
    // and both get the provisional entitlement, flagged `default` so the console
    // can say "policy not configured" instead of presenting a guess as policy.
    return {
      days: FALLBACK_ENTITLEMENT_DAYS[leaveTypeCode] ?? 0,
      carry_forward_days: 0,
      source: "default",
    };
  } catch (err) {
    warnOnce(
      `entitlement:${tenantId}`,
      `S6 leave policy unreadable, using flat provisional entitlement with no tenure band, ` +
        `accrual or pro-rating: ${String(err)}`,
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
 * holidays for that employee's state.
 *
 * **Reconciled with S6.** Both guesses this file shipped with were wrong, in the
 * way the header predicted. There is no `leave_work_weeks` table — the work week
 * lives in `leave_settings.work_week` as a seven-fraction JSON array, overridable
 * per employee in `employee_leave_profiles.work_week`. And matching holiday scope
 * against `employees.location` was a placeholder: S6 introduced exactly the
 * dedicated column that note anticipated, `employee_leave_profiles.work_state`.
 *
 * Rather than re-query either, this now calls S6's own helpers. That matters
 * beyond tidiness: S6's holiday engine merges a shipped national calendar with
 * tenant overrides, honours the `observed = 0` suppression rows, and knows which
 * years are still lunar projections — none of which a `SELECT holiday_date`
 * would have picked up, and all of which change how many working days a request
 * costs.
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
    const [settings, profile] = await Promise.all([
      getS6Settings(env.DB, tenantId),
      getS6Profile(env.DB, tenantId, employee.employee_id),
    ]);
    // Seven fractions indexed from Sunday: 1 = a full working day, 0 = off, 0.5
    // = a half day. This module counts whole working days, so anything above
    // zero counts as a day the employee is expected in — a Saturday half-day
    // week still has leave taken on Saturday cost a day.
    const week = profile.work_week ?? settings.work_week;
    const parsed = new Set<number>();
    week.forEach((fraction, day) => {
      if (fraction > 0) parsed.add(day);
    });
    if (parsed.size > 0) workDays = parsed;

    // S6's engine, not a raw query: it merges the shipped national calendar with
    // the tenant's own rows, drops dates the tenant suppressed with
    // `observed = 0`, and scopes state holidays by `work_state`.
    const byYear = await effectiveHolidays(env.DB, tenantId, profile.work_state, [year]);
    holidays = new Set(byYear.get(year)?.byDate.keys() ?? []);
  } catch (err) {
    degraded = true;
    warnOnce(
      `calendar:${tenantId}`,
      `S6 work week and/or public holidays unreadable, counting Mon–Fri with NO public ` +
        `holidays: ${String(err)}`,
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
