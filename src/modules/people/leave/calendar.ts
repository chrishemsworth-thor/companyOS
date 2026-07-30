import type { WorkCalendar } from "./types";

/**
 * Working-day arithmetic (PRD-006 § "Leave: public holidays").
 *
 * Pure functions over an ISO date string and a `WorkCalendar`. No database, no
 * `Date` locale behaviour: every date is parsed as UTC midnight, so a Worker
 * running in any timezone counts the same days. That matters more than it looks
 * — `new Date("2026-08-01")` is UTC midnight but `new Date(2026, 7, 1)` is local
 * midnight, and mixing them silently shifts a leave span by a day for anyone
 * east of Greenwich. Malaysia is UTC+8, so it would shift for the only market
 * this PRD is for.
 *
 * The tenant timezone does not exist anywhere in `src/` (SESSION-PLAN's codebase
 * facts table says so, and flags it for S10). It is not needed here: leave is
 * counted in whole and half *days* against a work week, never in hours, so the
 * only thing that matters is that a date string maps to a stable weekday.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  // Rejects 2026-02-30, which the regex happily accepts: round-tripping through
  // Date normalises an impossible day into the next month, so a mismatch on the
  // way back out means the input was not a real date.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** UTC midnight for an ISO date. */
function parseIso(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every date from `start` to `end` inclusive. */
export function datesInSpan(start: string, end: string): string[] {
  const out: string[] = [];
  const last = parseIso(end).getTime();
  for (let t = parseIso(start).getTime(); t <= last; t += DAY_MS) {
    out.push(toIso(new Date(t)));
  }
  return out;
}

/** Inclusive calendar-day count. */
export function calendarDays(start: string, end: string): number {
  return Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / DAY_MS) + 1;
}

/** Do two inclusive spans share at least one day? */
export function spansOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export interface CountedDays {
  /** Whole working days before half-day adjustment. */
  workingDays: number;
  /** Days in the span that were not counted, with the reason. */
  excluded: Array<{ date: string; reason: "non_working_day" | "public_holiday" }>;
  /** Working dates, in order. Needed to apply half-days to the right ends. */
  workingDates: string[];
}

/**
 * Count the working days in a span, excluding non-working weekdays and the
 * employee's applicable public holidays.
 *
 * PRD-006's criterion is "given leave spanning a weekend and a state holiday,
 * then only working days are deducted", and the `excluded` list is what lets the
 * console *show* that rather than just asserting a smaller number — an office
 * manager who cannot see why 7 days became 4 does not trust the 4.
 *
 * A holiday falling on a non-working day is reported as `non_working_day`: it
 * was already not going to be worked, and calling it a holiday would imply the
 * employee got something for it.
 */
export function countWorkingDays(
  start: string,
  end: string,
  calendar: WorkCalendar,
): CountedDays {
  const excluded: CountedDays["excluded"] = [];
  const workingDates: string[] = [];

  for (const date of datesInSpan(start, end)) {
    if (!calendar.workDays.has(parseIso(date).getUTCDay())) {
      excluded.push({ date, reason: "non_working_day" });
      continue;
    }
    if (calendar.holidays.has(date)) {
      excluded.push({ date, reason: "public_holiday" });
      continue;
    }
    workingDates.push(date);
  }

  return { workingDays: workingDates.length, excluded, workingDates };
}

/**
 * Working days after half-day adjustment.
 *
 * A half day is only deductible from a day that would have been worked, so the
 * flags apply to the first and last *working* dates in the span rather than to
 * `start_date`/`end_date` — a Friday-to-Monday request with `end_half_day` on a
 * Monday public holiday must not deduct half a day nobody was working.
 *
 * When the span has exactly one working day, `start_half_day` and
 * `end_half_day` describe the same day, so setting both still deducts 0.5 rather
 * than 0. Two flags on one day means "half of that day", not "none of it".
 */
export function applyHalfDays(
  counted: CountedDays,
  startHalfDay: boolean,
  endHalfDay: boolean,
): number {
  if (counted.workingDays === 0) return 0;

  let days = counted.workingDays;
  if (counted.workingDays === 1) {
    return startHalfDay || endHalfDay ? 0.5 : 1;
  }
  if (startHalfDay) days -= 0.5;
  if (endHalfDay) days -= 0.5;
  return days;
}

/**
 * The full computation: count, then adjust. The one entry point the service
 * uses, so working-day arithmetic has exactly one definition.
 */
export function workingDaysFor(
  start: string,
  end: string,
  calendar: WorkCalendar,
  startHalfDay: boolean,
  endHalfDay: boolean,
): { workingDays: number; excluded: CountedDays["excluded"]; calendarDays: number } {
  const counted = countWorkingDays(start, end, calendar);
  return {
    workingDays: applyHalfDays(counted, startHalfDay, endHalfDay),
    excluded: counted.excluded,
    calendarDays: calendarDays(start, end),
  };
}

/** Calendar year of an ISO date — the year balances are computed against. */
export function yearOf(date: string): number {
  return Number.parseInt(date.slice(0, 4), 10);
}
