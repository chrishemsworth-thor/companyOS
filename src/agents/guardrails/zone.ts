/**
 * Tenant-local time, from an IANA zone name.
 *
 * PRD-002 puts "no contact outside 09:00-18:00 tenant local time" in the P0
 * guardrails and calls a WhatsApp at 2am "a product-defining mistake". Workers
 * run in UTC and the tenant is in UTC+8, so every hour comparison in the guard
 * has to cross a timezone — and the only correct way to do that without a
 * dependency is `Intl.DateTimeFormat`, which workerd ships with full ICU data
 * (verified: `Asia/Kuala_Lumpur` resolves, and `Pacific/Auckland` correctly
 * reads +13 in January, so the arithmetic here is DST-aware for free).
 *
 * Nothing in this file throws on bad input. An unknown zone name resolves to
 * `DEFAULT_TIME_ZONE` with a warning, because the alternative — a guard that
 * throws inside the send path — would stop collections, and PRD-002's
 * non-negotiable is that collections never silently stops.
 */

/** Malaysia. Every default in this module is a Malaysian SME default. */
export const DEFAULT_TIME_ZONE = "Asia/Kuala_Lumpur";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Formatters are not cheap to build and the guard asks the same zone
 * repeatedly within one assessment. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // h23, not hour12:false — some locales render midnight as hour "24"
      // under hour12:false, and an off-by-24 in a contact window is exactly
      // the 2am send this guard exists to prevent.
      hourCycle: "h23",
    });
    formatters.set(tz, fmt);
  }
  return fmt;
}

/**
 * `tz` if usable, else the Malaysian default. Callers pass tenant data
 * straight through — validation happens at the settings endpoint, and this is
 * the backstop for a row written before that validation existed.
 */
export function resolveTimeZone(tz: string | null | undefined): string {
  if (tz && isValidTimeZone(tz)) return tz;
  if (tz) console.warn(`[guardrails] unknown timezone "${tz}", using ${DEFAULT_TIME_ZONE}`);
  return DEFAULT_TIME_ZONE;
}

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** `YYYY-MM-DD` in the zone — the key `public_holidays` and the work week use. */
  date: string;
  /** 0 = Sunday … 6 = Saturday, matching `leave_settings.work_week` indexing. */
  weekday: number;
}

/** Wall-clock reading of `at` in `tz`. */
export function zoneParts(tz: string, at: number): ZoneParts {
  const parts = formatterFor(tz).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    date: `${year}-${pad(month)}-${pad(day)}`,
    // Via Date.UTC on the LOCAL date, never the local-time Date constructor —
    // the same rule src/modules/leave/dates.ts documents, for the same reason.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Offset of `tz` from UTC at instant `at`, in ms (UTC+8 → +28_800_000). */
export function zoneOffsetMs(tz: string, at: number): number {
  const p = zoneParts(tz, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // `at` may carry milliseconds the formatter dropped; compare like with like.
  return asUtc - Math.floor(at / 1000) * 1000;
}

export interface WallTime {
  /** `YYYY-MM-DD` in the target zone. */
  date: string;
  hour: number;
  minute?: number;
}

/**
 * Wall-clock time in `tz` → epoch ms. Two passes because the offset itself
 * depends on the instant: the first guess uses the offset at the naive UTC
 * reading, the second uses the offset at the instant that produced. That
 * converges everywhere a zone has a single offset change per transition, which
 * is every real zone.
 *
 * A wall time inside a spring-forward gap does not exist; the result lands just
 * after the gap, which for a "defer until 09:00" is the right answer anyway.
 */
export function wallToEpoch(tz: string, wall: WallTime): number {
  const [y, m, d] = wall.date.split("-").map(Number);
  const naive = Date.UTC(y!, (m ?? 1) - 1, d ?? 1, wall.hour, wall.minute ?? 0, 0, 0);
  const first = naive - zoneOffsetMs(tz, naive);
  return naive - zoneOffsetMs(tz, first);
}
