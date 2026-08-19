import { addDays } from "../../modules/leave/dates";
import type { AgentPolicy } from "./policy";
import { wallToEpoch, zoneParts } from "./zone";

/**
 * "May the agent contact anybody right now, and if not, when?"
 *
 * Hours, non-working days and public holidays are answered together on purpose.
 * Answering them separately is how "defer to the next window" turns into
 * "defer onto a Sunday morning": the next open *hour* and the next open *day*
 * are not the same question, and only their intersection is a time a human
 * would want to receive a payment reminder.
 */

/** Public-holiday lookup, keyed on a tenant-local `YYYY-MM-DD`. */
export interface HolidayLookup {
  isHoliday(isoDate: string): boolean;
}

export const NO_HOLIDAYS: HolidayLookup = { isHoliday: () => false };

export interface ContactWindow {
  /** True when a send may happen at the instant asked about. */
  open: boolean;
  /** When the window next opens. Equals the instant asked about when open. */
  next_open_at: number;
  /** Why it is shut: the tenant's hours, a non-working day, or a holiday. */
  reason: "open" | "outside_hours" | "non_working_day" | "public_holiday";
  /** The holiday's name, when that is the reason — it goes in the audit detail. */
  detail: string | null;
}

/** How far forward to look for an open day before deciding the calendar itself
 * is the problem. Two weeks covers Malaysia's longest holiday clusters with
 * room to spare. */
const MAX_LOOKAHEAD_DAYS = 14;

function dayState(
  policy: AgentPolicy,
  isoDate: string,
  weekday: number,
  holidays: HolidayLookup,
): { allowed: boolean; reason: ContactWindow["reason"]; detail: string | null } {
  if (policy.suppress_weekends && (policy.work_week[weekday] ?? 0) === 0) {
    return { allowed: false, reason: "non_working_day", detail: isoDate };
  }
  if (policy.suppress_holidays && holidays.isHoliday(isoDate)) {
    return { allowed: false, reason: "public_holiday", detail: isoDate };
  }
  return { allowed: true, reason: "open", detail: null };
}

function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

/**
 * Evaluate the contact window at `at` (epoch ms).
 *
 * When shut, `next_open_at` is the start of the next permitted window — the
 * agent defers to it and never drops the send, which is PRD-002's explicit
 * requirement and the difference between a late reminder and a lost one.
 */
export function contactWindow(
  policy: AgentPolicy,
  at: number,
  holidays: HolidayLookup = NO_HOLIDAYS,
): ContactWindow {
  const local = zoneParts(policy.timezone, at);
  const today = dayState(policy, local.date, local.weekday, holidays);
  const withinHours =
    local.hour >= policy.contact_window_start_hour && local.hour < policy.contact_window_end_hour;

  if (today.allowed && withinHours) {
    return { open: true, next_open_at: at, reason: "open", detail: null };
  }

  // Later today, if today is a working day and the window has not opened yet.
  if (today.allowed && local.hour < policy.contact_window_start_hour) {
    return {
      open: false,
      next_open_at: wallToEpoch(policy.timezone, {
        date: local.date,
        hour: policy.contact_window_start_hour,
      }),
      reason: "outside_hours",
      detail: `before ${policy.contact_window_start_hour}:00 ${policy.timezone}`,
    };
  }

  // Otherwise the next working, non-holiday day at opening time. The reason
  // reported is the reason TODAY is shut, which is what the audit record wants:
  // "deferred because it is Hari Raya", not "deferred because of hours".
  const reason: ContactWindow["reason"] = today.allowed ? "outside_hours" : today.reason;
  const detail = today.allowed
    ? `after ${policy.contact_window_end_hour}:00 ${policy.timezone}`
    : today.detail;

  let date = local.date;
  for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i++) {
    date = addDays(date, 1);
    if (dayState(policy, date, weekdayOf(date), holidays).allowed) {
      return {
        open: false,
        next_open_at: wallToEpoch(policy.timezone, {
          date,
          hour: policy.contact_window_start_hour,
        }),
        reason,
        detail,
      };
    }
  }

  // No working day within two weeks means the work week or the holiday table is
  // misconfigured (a work_week of all zeros, say). Honour the HOURS and give up
  // on the days rather than deferring forever: a reminder a day late is a
  // product decision, a reminder never sent is a silent stop.
  console.warn(
    `[guardrails] no working day within ${MAX_LOOKAHEAD_DAYS} days of ${local.date}; deferring on hours only`,
  );
  return {
    open: false,
    next_open_at: wallToEpoch(policy.timezone, {
      date: addDays(local.date, 1),
      hour: policy.contact_window_start_hour,
    }),
    reason,
    detail,
  };
}
