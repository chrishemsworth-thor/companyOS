import { dayOfWeek, eachDay, isIsoDate } from "./dates";
import type { HolidaySet } from "./holidays/resolve";
import { LeaveError, type WorkWeek } from "./types";

/**
 * Working-day counting — the number PRD-006 wants shown before submission and
 * the number that comes off a balance.
 *
 * Three things reduce a calendar span to working days:
 *
 *   1. **The work week.** 7 fractions, index 0 = Sunday. Mon-Fri by default;
 *      Kelantan and Terengganu run Sun-Thu; a Saturday half-day is 0.5.
 *   2. **Public holidays** applicable to the employee's work state, already
 *      merged from the shipped calendar and the tenant's overrides.
 *   3. **Half days** on the boundaries of the run.
 *
 * A holiday falling on a non-working day costs nothing extra — the day was
 * already free — which is why holidays are applied by zeroing the day's
 * fraction rather than by subtracting a count.
 */

export interface WorkingDaysBreakdown {
  working_days: number;
  calendar_days: number;
  /** Days excluded because the work week says they are not worked. */
  non_working_days: number;
  /** Holidays that landed on a day that would otherwise have been worked —
   * i.e. holidays that actually saved the employee something. */
  holidays: { date: string; name: string }[];
  /** True when the shipped calendar has no data for a year in this range.
   * Surfaced rather than swallowed: silently counting a year with no holiday
   * data would over-deduct, and an employee would only find out afterwards. */
  holiday_data_available: boolean;
  /** True when a year in range is still a projection. */
  holiday_data_provisional: boolean;
}

export interface HalfDayOptions {
  /** Take only half of the first working day. */
  start_half_day?: boolean;
  /** Take only half of the last working day. */
  end_half_day?: boolean;
}

/** Validate and narrow a work week coming off the wire or out of D1. */
export function parseWorkWeek(raw: unknown): WorkWeek {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(value) || value.length !== 7) {
    throw new LeaveError("invalid_work_week", "work_week must be 7 numbers, index 0 = Sunday");
  }
  const week = value.map((v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new LeaveError("invalid_work_week", "each work_week entry must be between 0 and 1");
    }
    return v;
  });
  if (week.every((v) => v === 0)) {
    // A tenant with no working days at all would make every leave request cost
    // zero days, which is a configuration mistake rather than a business model.
    throw new LeaveError("invalid_work_week", "work_week must contain at least one working day");
  }
  return week as unknown as WorkWeek;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new LeaveError("invalid_work_week", "work_week is not valid JSON");
  }
}

/**
 * Count working days between two inclusive ISO dates.
 *
 * Half days apply to the first and last *worked* day of the run, not the first
 * and last calendar day: a Friday-to-Monday request with `end_half_day` takes
 * half of Monday, and a request starting on a Saturday the tenant does not work
 * puts the half day on the Monday that actually starts the leave.
 */
export function countWorkingDays(
  startDate: string,
  endDate: string,
  workWeek: WorkWeek,
  holidays: HolidaySet,
  options: HalfDayOptions = {},
): WorkingDaysBreakdown {
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new LeaveError("invalid_request", "start_date and end_date must be YYYY-MM-DD", 400);
  }
  if (endDate < startDate) {
    throw new LeaveError("invalid_request", "end_date must not precede start_date", 400);
  }

  const worked: { date: string; fraction: number }[] = [];
  const observedHolidays: { date: string; name: string }[] = [];
  let calendarDays = 0;
  let nonWorkingDays = 0;

  for (const date of eachDay(startDate, endDate)) {
    calendarDays += 1;
    const fraction = workWeek[dayOfWeek(date)] ?? 0;
    if (fraction <= 0) {
      nonWorkingDays += 1;
      continue;
    }
    const holiday = holidays.byDate.get(date);
    if (holiday) {
      // Only counts as a saved day if it displaced work — a holiday on a
      // Sunday saves a Mon-Fri employee nothing.
      observedHolidays.push({ date, name: holiday.name });
      nonWorkingDays += 1;
      continue;
    }
    worked.push({ date, fraction });
  }

  if (worked.length > 0) {
    if (options.start_half_day) {
      const first = worked[0]!;
      first.fraction = first.fraction / 2;
    }
    if (options.end_half_day) {
      const last = worked[worked.length - 1]!;
      // A single working day marked half on both ends is still half a day, not
      // a quarter — the two flags describe the same day.
      last.fraction = worked.length === 1 && options.start_half_day
        ? last.fraction
        : last.fraction / 2;
    }
  }

  const workingDays = worked.reduce((sum, d) => sum + d.fraction, 0);

  return {
    // Guard against float dust from repeated halving (0.1 + 0.2 arithmetic).
    working_days: Math.round(workingDays * 100) / 100,
    calendar_days: calendarDays,
    non_working_days: nonWorkingDays,
    holidays: observedHolidays,
    holiday_data_available: holidays.dataAvailable,
    holiday_data_provisional: holidays.provisional,
  };
}
