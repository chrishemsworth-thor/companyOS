import type { EffectiveHoliday, TenantHoliday } from "../types";
import { yearOf } from "../dates";
import { appliesTo, scopeFor, shippedYear, type HolidayYear } from "./data";
import type { HolidayScope } from "./states";

/**
 * Merge the shipped calendar with the tenant's deltas.
 *
 * The rule, in one line: **shipped ∪ tenant additions − tenant suppressions**,
 * where a tenant row on the same (date, scope) as a shipped holiday overrides
 * it — `observed: true` renames it, `observed: false` removes it.
 *
 * Everything is keyed on `date + scope`, not on date alone. That matters: a
 * Selangor employee and a Sarawak employee can both have a holiday on the same
 * date for different reasons, and a tenant suppressing the Selangor one must
 * not silently remove Sarawak's.
 */

export interface HolidaySet {
  /** date → the effective holiday for this employee on that date. */
  byDate: Map<string, EffectiveHoliday>;
  /** False when the shipped calendar has no data for the year at all — the
   * caller must say so rather than let an empty set read as "no holidays". */
  dataAvailable: boolean;
  /** True when the shipped year's lunar/Islamic dates are still projections. */
  provisional: boolean;
  sourceNote: string | null;
}

/** The scopes that apply to somebody working in `state`. */
function scopesFor(state: string | null): Set<string> {
  return new Set(state ? ["national", state] : ["national"]);
}

/**
 * Build the effective holiday set for one year and one work state.
 *
 * `tenantRows` should be every `public_holidays` row for the tenant in the
 * year — filtering by scope happens here so the caller does one query per year
 * rather than one per employee.
 */
export function resolveHolidays(
  year: number,
  workState: string | null,
  tenantRows: readonly TenantHoliday[],
): HolidaySet {
  const scopes = scopesFor(workState);
  const shipped: HolidayYear | null = shippedYear(year);

  // Tenant rows first, keyed on date+scope, so the shipped pass can check
  // whether the tenant has already ruled on a given day.
  const tenantByKey = new Map<string, TenantHoliday>();
  for (const row of tenantRows) {
    if (yearOf(row.holiday_date) !== year) continue;
    if (!scopes.has(row.scope)) continue;
    tenantByKey.set(`${row.holiday_date}|${row.scope}`, row);
  }

  const byDate = new Map<string, EffectiveHoliday>();

  if (shipped) {
    for (const holiday of shipped.holidays) {
      if (!appliesTo(holiday, workState)) continue;
      const scope = scopeFor(holiday, workState);
      if (!scope) continue;
      const override = tenantByKey.get(`${holiday.date}|${scope}`);
      // A suppression removes it outright; an override is handled in the
      // tenant pass below (which runs second and wins).
      if (override && !override.observed) continue;
      if (override) continue;
      byDate.set(holiday.date, {
        date: holiday.date,
        name: holiday.name,
        scope,
        source: "shipped",
      });
    }
  }

  // Tenant additions and renames. Runs after the shipped pass so it wins on a
  // collision, which is the whole point of an override.
  for (const row of tenantByKey.values()) {
    if (!row.observed) {
      // A suppression only removes a shipped holiday it actually shadows. If
      // the shipped entry sat on a different scope (national vs state), the
      // day may still be a holiday for another reason — so re-check.
      const existing = byDate.get(row.holiday_date);
      if (existing && existing.scope === row.scope) byDate.delete(row.holiday_date);
      continue;
    }
    byDate.set(row.holiday_date, {
      date: row.holiday_date,
      name: row.name,
      scope: row.scope as HolidayScope,
      source: "tenant",
    });
  }

  return {
    byDate,
    dataAvailable: shipped !== null,
    provisional: shipped?.provisional ?? false,
    sourceNote: shipped?.source_note ?? null,
  };
}

/** Merge the sets for several years into one lookup — a leave run, or a leave
 * year query, can straddle 31 December. */
export function mergeHolidaySets(sets: readonly HolidaySet[]): HolidaySet {
  const byDate = new Map<string, EffectiveHoliday>();
  for (const set of sets) for (const [date, h] of set.byDate) byDate.set(date, h);
  return {
    byDate,
    // Conservative on both flags: if any year in range is missing or
    // provisional, the answer as a whole is.
    dataAvailable: sets.every((s) => s.dataAvailable),
    provisional: sets.some((s) => s.provisional),
    sourceNote: sets.find((s) => s.sourceNote)?.sourceNote ?? null,
  };
}

/** Effective holidays as a sorted list — the API shape. */
export function holidayList(set: HolidaySet): EffectiveHoliday[] {
  return [...set.byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
