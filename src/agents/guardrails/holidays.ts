import { effectiveHolidays } from "../../modules/leave/service";
import { mergeHolidaySets } from "../../modules/leave/holidays/resolve";
import type { HolidayLookup } from "./window";
import { NO_HOLIDAYS } from "./window";
import { zoneParts } from "./zone";

/**
 * Public holidays for the guard, from **S6's `public_holidays`** — the shipped
 * Malaysian calendar merged with the tenant's own additions and suppressions
 * (`src/modules/leave/holidays/resolve.ts`). Not a second holiday source: S6
 * already owns this data, has a console for it, and lets a tenant that trades
 * through Thaipusam say so once rather than twice.
 *
 * Resolved on the `national` scope (`workState = null`). Leave asks "is this
 * employee's state closed"; collections asks "is the country closed", and a
 * Selangor-only holiday is not a reason to withhold an invoice reminder from a
 * customer in Penang.
 */
export async function loadHolidayLookup(
  db: D1Database,
  tenantId: string,
  timezone: string,
  at: number,
): Promise<HolidayLookup> {
  const year = zoneParts(timezone, at).year;
  try {
    // This year and next: the window can look up to two weeks ahead, which in
    // late December means asking about January.
    const byYear = await effectiveHolidays(db, tenantId, null, [year, year + 1]);
    const merged = mergeHolidaySets([...byYear.values()]);
    // `dataAvailable: false` (the shipped calendar has no data for the year)
    // deliberately reads as "no holidays", NOT "suppress everything". The
    // alternative stops collections for a whole year, silently, the first
    // January past the end of the shipped calendar.
    if (!merged.dataAvailable) {
      console.warn(`[guardrails] no shipped holiday data for ${year}; not suppressing on holidays`);
    }
    return { isHoliday: (date) => merged.byDate.has(date) };
  } catch (err) {
    // Same rule as the policy load: a guard that throws stops collections.
    console.warn(`[guardrails] holiday load failed for ${tenantId}: ${String(err)}`);
    return NO_HOLIDAYS;
  }
}
