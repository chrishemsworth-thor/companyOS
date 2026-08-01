import { allStatesExcept, type HolidayScope, type StateCode } from "./states";

/**
 * The shipped Malaysian public-holiday calendar.
 *
 * This file IS the SESSION-PLAN blocking decision for S6: public holidays come
 * from a maintained data file shipped with releases, not from a manual
 * per-tenant seed. State variation is the whole reason — Selangor, Penang and
 * Sarawak genuinely differ, and asking every tenant to key ~20 dates a year is
 * an annual support burden that produces wrong answers.
 *
 * ## How this interacts with the database
 *
 * These rows are NEVER written to `public_holidays`. That table holds only the
 * tenant's deltas — additions and suppressions — and the effective set is
 * resolved at read time by `resolve.ts`. So updating the calendar for a new
 * year is a code change and a deploy, with no data migration and no risk of
 * trampling a tenant's own edits.
 *
 * ## Accuracy, honestly
 *
 * Fixed-date holidays (Merdeka, Labour Day, Christmas) are certain. Islamic
 * dates depend on moon sighting and Chinese and Hindu dates on lunar
 * calendars, so a future year's entries are a projection until the federal and
 * state gazettes confirm them. Each year therefore carries `provisional`, and
 * the API surfaces it — an office manager should be told which numbers are
 * still soft rather than discovering it in April.
 *
 * A tenant does not have to wait for us either way: a wrong date is one
 * `POST /v1/people/leave/holidays` (add the right one) plus one suppression
 * (`observed: false`) of the wrong one.
 *
 * ## Known gaps
 *
 * State ruler birthdays are included only where the date is settled. Perak and
 * Kelantan are deliberately omitted rather than guessed — see
 * docs/modules/leave.md. Substitution days (a holiday falling on a Sunday being
 * observed on the Monday) are not modelled; they are gazetted per state per
 * year and are a natural tenant override.
 *
 * ## Adding a year
 *
 * Append a `HolidayYear` to `MY_PUBLIC_HOLIDAYS`, set `provisional` honestly,
 * and run `npm test` — `test/leave-holidays.test.ts` checks the structure
 * (dates inside their own year, valid scopes, no duplicate date+scope pairs).
 * It cannot check that the dates are RIGHT; only the gazette can do that.
 */

export interface ShippedHoliday {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  name: string;
  /**
   * `national` (every state) or the explicit list of states that observe it.
   * A list is used even for near-national holidays, because "national except
   * Sarawak" is a real and load-bearing distinction for Deepavali.
   */
  scopes: "national" | readonly StateCode[];
}

export interface HolidayYear {
  year: number;
  /**
   * True when the year's lunar and Islamic dates are still projections rather
   * than gazetted. Surfaced by the API so HR knows to verify.
   */
  provisional: boolean;
  /** Shown alongside `provisional` in the API response. */
  source_note: string;
  holidays: readonly ShippedHoliday[];
}

// Scope shorthands for the holidays whose state coverage is the interesting
// part. Written as "everything except" because that is how the gazette reads
// and how an office manager thinks about it.
const EXCEPT_NO_NEW_YEAR = allStatesExcept("JHR", "KDH", "KTN", "PLS", "TRG");
const EXCEPT_SARAWAK = allStatesExcept("SWK");
const EXCEPT_KTN_TRG = allStatesExcept("KTN", "TRG");

const FEDERAL_TERRITORIES: StateCode[] = ["KUL", "LBN", "PJY"];
const THAIPUSAM_STATES: StateCode[] = ["JHR", "KUL", "NSN", "PJY", "PNG", "PRK", "SGR"];
const NUZUL_QURAN_STATES: StateCode[] = [
  "KTN",
  "KUL",
  "LBN",
  "PHG",
  "PJY",
  "PLS",
  "PNG",
  "PRK",
  "SGR",
  "TRG",
];
const AWAL_RAMADAN_STATES: StateCode[] = ["JHR", "KDH", "MLK"];
const ISRAK_MIKRAJ_STATES: StateCode[] = ["KDH", "NSN", "PLS", "TRG"];
const GOOD_FRIDAY_STATES: StateCode[] = ["SBH", "SWK"];
const RAYA_HAJI_SECOND_DAY_STATES: StateCode[] = ["KDH", "KTN", "PLS", "TRG"];
const KAAMATAN_STATES: StateCode[] = ["LBN", "SBH"];

export const MY_PUBLIC_HOLIDAYS: readonly HolidayYear[] = [
  {
    year: 2025,
    provisional: false,
    source_note: "Gazetted; historical year.",
    holidays: [
      { date: "2025-01-01", name: "New Year's Day", scopes: EXCEPT_NO_NEW_YEAR },
      { date: "2025-01-14", name: "Birthday of the Yang di-Pertuan Besar of Negeri Sembilan", scopes: ["NSN"] },
      { date: "2025-01-29", name: "Chinese New Year", scopes: "national" },
      { date: "2025-01-30", name: "Chinese New Year (Second Day)", scopes: EXCEPT_KTN_TRG },
      { date: "2025-02-01", name: "Federal Territory Day", scopes: FEDERAL_TERRITORIES },
      { date: "2025-02-11", name: "Thaipusam", scopes: THAIPUSAM_STATES },
      { date: "2025-03-02", name: "Awal Ramadan", scopes: AWAL_RAMADAN_STATES },
      { date: "2025-03-18", name: "Nuzul Al-Quran", scopes: NUZUL_QURAN_STATES },
      { date: "2025-03-23", name: "Birthday of the Sultan of Johor", scopes: ["JHR"] },
      { date: "2025-03-31", name: "Hari Raya Aidilfitri", scopes: "national" },
      { date: "2025-04-01", name: "Hari Raya Aidilfitri (Second Day)", scopes: "national" },
      { date: "2025-04-18", name: "Good Friday", scopes: GOOD_FRIDAY_STATES },
      { date: "2025-04-26", name: "Birthday of the Sultan of Terengganu", scopes: ["TRG"] },
      { date: "2025-05-01", name: "Labour Day", scopes: "national" },
      { date: "2025-05-12", name: "Wesak Day", scopes: "national" },
      { date: "2025-05-17", name: "Birthday of the Raja of Perlis", scopes: ["PLS"] },
      { date: "2025-05-30", name: "Pesta Kaamatan", scopes: KAAMATAN_STATES },
      { date: "2025-05-31", name: "Pesta Kaamatan (Second Day)", scopes: KAAMATAN_STATES },
      { date: "2025-06-01", name: "Hari Gawai", scopes: ["SWK"] },
      { date: "2025-06-02", name: "Birthday of the Yang di-Pertuan Agong", scopes: "national" },
      { date: "2025-06-07", name: "Hari Raya Haji", scopes: "national" },
      { date: "2025-06-08", name: "Hari Raya Haji (Second Day)", scopes: RAYA_HAJI_SECOND_DAY_STATES },
      { date: "2025-06-15", name: "Birthday of the Sultan of Kedah", scopes: ["KDH"] },
      { date: "2025-06-27", name: "Awal Muharram", scopes: "national" },
      { date: "2025-07-12", name: "Birthday of the Governor of Pulau Pinang", scopes: ["PNG"] },
      { date: "2025-07-22", name: "Sarawak Day", scopes: ["SWK"] },
      { date: "2025-07-30", name: "Birthday of the Sultan of Pahang", scopes: ["PHG"] },
      { date: "2025-08-24", name: "Birthday of the Governor of Melaka", scopes: ["MLK"] },
      { date: "2025-08-31", name: "National Day", scopes: "national" },
      { date: "2025-09-05", name: "Maulidur Rasul", scopes: "national" },
      { date: "2025-09-16", name: "Malaysia Day", scopes: "national" },
      { date: "2025-10-04", name: "Birthday of the Governor of Sabah", scopes: ["SBH"] },
      { date: "2025-10-11", name: "Birthday of the Governor of Sarawak", scopes: ["SWK"] },
      { date: "2025-10-20", name: "Deepavali", scopes: EXCEPT_SARAWAK },
      { date: "2025-12-11", name: "Birthday of the Sultan of Selangor", scopes: ["SGR"] },
      { date: "2025-12-25", name: "Christmas Day", scopes: "national" },
    ],
  },
  {
    year: 2026,
    provisional: false,
    source_note: "Gazetted federal calendar; state ruler birthdays per state gazette.",
    holidays: [
      { date: "2026-01-01", name: "New Year's Day", scopes: EXCEPT_NO_NEW_YEAR },
      { date: "2026-01-14", name: "Birthday of the Yang di-Pertuan Besar of Negeri Sembilan", scopes: ["NSN"] },
      { date: "2026-02-01", name: "Thaipusam", scopes: THAIPUSAM_STATES },
      { date: "2026-02-01", name: "Federal Territory Day", scopes: FEDERAL_TERRITORIES },
      { date: "2026-02-17", name: "Chinese New Year", scopes: "national" },
      { date: "2026-02-18", name: "Chinese New Year (Second Day)", scopes: EXCEPT_KTN_TRG },
      { date: "2026-02-19", name: "Awal Ramadan", scopes: AWAL_RAMADAN_STATES },
      { date: "2026-03-07", name: "Nuzul Al-Quran", scopes: NUZUL_QURAN_STATES },
      { date: "2026-03-20", name: "Hari Raya Aidilfitri", scopes: "national" },
      { date: "2026-03-21", name: "Hari Raya Aidilfitri (Second Day)", scopes: "national" },
      { date: "2026-03-23", name: "Birthday of the Sultan of Johor", scopes: ["JHR"] },
      { date: "2026-04-03", name: "Good Friday", scopes: GOOD_FRIDAY_STATES },
      { date: "2026-04-26", name: "Birthday of the Sultan of Terengganu", scopes: ["TRG"] },
      { date: "2026-05-01", name: "Labour Day", scopes: "national" },
      { date: "2026-05-17", name: "Birthday of the Raja of Perlis", scopes: ["PLS"] },
      { date: "2026-05-27", name: "Hari Raya Haji", scopes: "national" },
      { date: "2026-05-28", name: "Hari Raya Haji (Second Day)", scopes: RAYA_HAJI_SECOND_DAY_STATES },
      { date: "2026-05-30", name: "Pesta Kaamatan", scopes: KAAMATAN_STATES },
      { date: "2026-05-31", name: "Wesak Day", scopes: "national" },
      { date: "2026-05-31", name: "Pesta Kaamatan (Second Day)", scopes: KAAMATAN_STATES },
      { date: "2026-06-01", name: "Birthday of the Yang di-Pertuan Agong", scopes: "national" },
      { date: "2026-06-01", name: "Hari Gawai", scopes: ["SWK"] },
      { date: "2026-06-02", name: "Hari Gawai (Second Day)", scopes: ["SWK"] },
      { date: "2026-06-16", name: "Awal Muharram", scopes: "national" },
      { date: "2026-06-21", name: "Birthday of the Sultan of Kedah", scopes: ["KDH"] },
      { date: "2026-07-11", name: "Birthday of the Governor of Pulau Pinang", scopes: ["PNG"] },
      { date: "2026-07-22", name: "Sarawak Day", scopes: ["SWK"] },
      { date: "2026-07-30", name: "Birthday of the Sultan of Pahang", scopes: ["PHG"] },
      { date: "2026-08-24", name: "Birthday of the Governor of Melaka", scopes: ["MLK"] },
      { date: "2026-08-25", name: "Maulidur Rasul", scopes: "national" },
      { date: "2026-08-31", name: "National Day", scopes: "national" },
      { date: "2026-09-16", name: "Malaysia Day", scopes: "national" },
      { date: "2026-10-03", name: "Birthday of the Governor of Sabah", scopes: ["SBH"] },
      { date: "2026-10-10", name: "Birthday of the Governor of Sarawak", scopes: ["SWK"] },
      { date: "2026-11-08", name: "Deepavali", scopes: EXCEPT_SARAWAK },
      { date: "2026-12-11", name: "Birthday of the Sultan of Selangor", scopes: ["SGR"] },
      { date: "2026-12-25", name: "Christmas Day", scopes: "national" },
    ],
  },
  {
    year: 2027,
    provisional: true,
    source_note:
      "PROVISIONAL. Islamic dates (Aidilfitri, Aidiladha, Awal Muharram, Maulidur Rasul, " +
      "Awal Ramadan, Nuzul Al-Quran) depend on moon sighting, and Chinese and Hindu dates on " +
      "the lunar calendar; all are projections until the federal and state gazettes confirm " +
      "them. Verify before publishing next year's leave calendar.",
    holidays: [
      { date: "2027-01-01", name: "New Year's Day", scopes: EXCEPT_NO_NEW_YEAR },
      { date: "2027-01-14", name: "Birthday of the Yang di-Pertuan Besar of Negeri Sembilan", scopes: ["NSN"] },
      { date: "2027-01-22", name: "Thaipusam", scopes: THAIPUSAM_STATES },
      { date: "2027-02-01", name: "Federal Territory Day", scopes: FEDERAL_TERRITORIES },
      { date: "2027-02-06", name: "Chinese New Year", scopes: "national" },
      { date: "2027-02-07", name: "Chinese New Year (Second Day)", scopes: EXCEPT_KTN_TRG },
      { date: "2027-02-08", name: "Awal Ramadan", scopes: AWAL_RAMADAN_STATES },
      { date: "2027-02-24", name: "Nuzul Al-Quran", scopes: NUZUL_QURAN_STATES },
      { date: "2027-03-09", name: "Hari Raya Aidilfitri", scopes: "national" },
      { date: "2027-03-10", name: "Hari Raya Aidilfitri (Second Day)", scopes: "national" },
      { date: "2027-03-23", name: "Birthday of the Sultan of Johor", scopes: ["JHR"] },
      { date: "2027-03-26", name: "Good Friday", scopes: GOOD_FRIDAY_STATES },
      { date: "2027-04-26", name: "Birthday of the Sultan of Terengganu", scopes: ["TRG"] },
      { date: "2027-05-01", name: "Labour Day", scopes: "national" },
      { date: "2027-05-17", name: "Birthday of the Raja of Perlis", scopes: ["PLS"] },
      { date: "2027-05-17", name: "Hari Raya Haji", scopes: "national" },
      { date: "2027-05-18", name: "Hari Raya Haji (Second Day)", scopes: RAYA_HAJI_SECOND_DAY_STATES },
      { date: "2027-05-20", name: "Wesak Day", scopes: "national" },
      { date: "2027-05-30", name: "Pesta Kaamatan", scopes: KAAMATAN_STATES },
      { date: "2027-05-31", name: "Pesta Kaamatan (Second Day)", scopes: KAAMATAN_STATES },
      { date: "2027-06-01", name: "Hari Gawai", scopes: ["SWK"] },
      { date: "2027-06-02", name: "Hari Gawai (Second Day)", scopes: ["SWK"] },
      { date: "2027-06-06", name: "Awal Muharram", scopes: "national" },
      { date: "2027-06-07", name: "Birthday of the Yang di-Pertuan Agong", scopes: "national" },
      { date: "2027-06-20", name: "Birthday of the Sultan of Kedah", scopes: ["KDH"] },
      { date: "2027-07-10", name: "Birthday of the Governor of Pulau Pinang", scopes: ["PNG"] },
      { date: "2027-07-22", name: "Sarawak Day", scopes: ["SWK"] },
      { date: "2027-07-30", name: "Birthday of the Sultan of Pahang", scopes: ["PHG"] },
      { date: "2027-08-15", name: "Maulidur Rasul", scopes: "national" },
      { date: "2027-08-24", name: "Birthday of the Governor of Melaka", scopes: ["MLK"] },
      { date: "2027-08-31", name: "National Day", scopes: "national" },
      { date: "2027-09-16", name: "Malaysia Day", scopes: "national" },
      { date: "2027-10-02", name: "Birthday of the Governor of Sabah", scopes: ["SBH"] },
      { date: "2027-10-09", name: "Birthday of the Governor of Sarawak", scopes: ["SWK"] },
      { date: "2027-10-28", name: "Deepavali", scopes: EXCEPT_SARAWAK },
      { date: "2027-12-11", name: "Birthday of the Sultan of Selangor", scopes: ["SGR"] },
      { date: "2027-12-25", name: "Christmas Day", scopes: "national" },
    ],
  },
];

/** Years the shipped calendar covers, ascending. */
export const SHIPPED_YEARS: readonly number[] = MY_PUBLIC_HOLIDAYS.map((y) => y.year);

export function shippedYear(year: number): HolidayYear | null {
  return MY_PUBLIC_HOLIDAYS.find((y) => y.year === year) ?? null;
}

/** Does a shipped holiday apply to somebody in `state`? A NULL work state gets
 * the national set only — the safe under-application: one holiday fewer, never
 * one they were not entitled to. */
export function appliesTo(holiday: ShippedHoliday, state: string | null): boolean {
  if (holiday.scopes === "national") return true;
  if (!state) return false;
  return (holiday.scopes as readonly string[]).includes(state);
}

/** The scope value a shipped holiday is stored/overridden under for a given
 * employee — `national`, or the state that observes it. This is the key a
 * tenant suppression must match. */
export function scopeFor(holiday: ShippedHoliday, state: string | null): HolidayScope | null {
  if (holiday.scopes === "national") return "national";
  if (!state) return null;
  return (holiday.scopes as readonly string[]).includes(state) ? (state as HolidayScope) : null;
}
