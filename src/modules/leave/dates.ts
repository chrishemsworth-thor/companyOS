/**
 * ISO-date arithmetic for leave.
 *
 * Every function here works on `YYYY-MM-DD` strings and goes through
 * `Date.UTC`, never the local-time `Date` constructor. That is deliberate:
 * `new Date("2026-07-01")` parses as UTC midnight but `new Date(2026, 6, 1)`
 * parses as *local* midnight, and mixing them shifts dates by a day either side
 * of a timezone boundary. A leave day counted twice — or not at all — because
 * of a timezone is exactly the class of bug PRD-006 says destroys trust, and
 * Workers run in UTC while the tenant is in UTC+8.
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  // Round-tripping catches 2026-02-30 and friends, which the regex cannot.
  return toIso(parseIso(value)) === value;
}

/** ISO date → epoch millis at UTC midnight. Assumes a well-formed input. */
export function parseIso(value: string): number {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export const DAY_MS = 86_400_000;

export function addDays(iso: string, days: number): string {
  return toIso(parseIso(iso) + days * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday, matching the work-week array's indexing. */
export function dayOfWeek(iso: string): number {
  return new Date(parseIso(iso)).getUTCDay();
}

export function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}

/** 1-12. */
export function monthOf(iso: string): number {
  return Number(iso.slice(5, 7));
}

/** 1-31. */
export function dayOf(iso: string): number {
  return Number(iso.slice(8, 10));
}

export function startOfYear(year: number): string {
  return `${year}-01-01`;
}

export function endOfYear(year: number): string {
  return `${year}-12-31`;
}

/** Inclusive day count between two ISO dates. */
export function daysBetween(startIso: string, endIso: string): number {
  return Math.round((parseIso(endIso) - parseIso(startIso)) / DAY_MS) + 1;
}

/** Iterate ISO dates from start to end, inclusive. */
export function* eachDay(startIso: string, endIso: string): Generator<string> {
  for (let t = parseIso(startIso), end = parseIso(endIso); t <= end; t += DAY_MS) {
    yield toIso(t);
  }
}

/**
 * Whole months of service completed at `asOf`, from `startDate`.
 *
 * "Completed" means the day-of-month has come round: someone who started on
 * 15 January has 0 completed months on 14 February and 1 on 15 February. This
 * is what the tenure bands are expressed in ("under 2 years" = under 24
 * months), so getting it wrong moves people between entitlement bands.
 */
export function monthsOfService(startDate: string, asOf: string): number {
  const startY = yearOf(startDate);
  const startM = monthOf(startDate);
  const startD = Number(startDate.slice(8, 10));
  const asY = yearOf(asOf);
  const asM = monthOf(asOf);
  const asD = Number(asOf.slice(8, 10));

  let months = (asY - startY) * 12 + (asM - startM);
  if (asD < startD) months -= 1;
  return Math.max(0, months);
}

/**
 * Round to the nearest half day, away from zero at the midpoint.
 *
 * Leave is transacted in half days, so every derived number — a pro-rated
 * entitlement, a monthly accrual, a carry-forward remainder — is rounded here
 * rather than left as 7.333333333333334, which would eventually surface in the
 * console as a balance nobody can reconcile.
 */
export function roundHalfDay(days: number): number {
  return Math.sign(days) * (Math.round(Math.abs(days) * 2) / 2);
}
