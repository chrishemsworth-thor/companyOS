/**
 * Malaysian states and federal territories, as ISO 3166-2:MY alpha codes.
 *
 * These are the values of `employee_leave_profiles.work_state` and of a
 * `public_holidays.scope` that is not `national`. They are a code registry in
 * TypeScript rather than a table or a SQL CHECK — the same choice the People
 * module makes for departments (`src/departments/registry.ts`), and for the
 * same reason: the list is fixed by geography, not by tenant, so a table would
 * be 16 rows copied per tenant that nobody ever edits.
 */

export const MY_STATES = [
  { code: "JHR", name: "Johor" },
  { code: "KDH", name: "Kedah" },
  { code: "KTN", name: "Kelantan" },
  { code: "KUL", name: "Kuala Lumpur" },
  { code: "LBN", name: "Labuan" },
  { code: "MLK", name: "Melaka" },
  { code: "NSN", name: "Negeri Sembilan" },
  { code: "PHG", name: "Pahang" },
  { code: "PJY", name: "Putrajaya" },
  { code: "PLS", name: "Perlis" },
  { code: "PNG", name: "Pulau Pinang" },
  { code: "PRK", name: "Perak" },
  { code: "SBH", name: "Sabah" },
  { code: "SGR", name: "Selangor" },
  { code: "SWK", name: "Sarawak" },
  { code: "TRG", name: "Terengganu" },
] as const;

export type StateCode = (typeof MY_STATES)[number]["code"];

export const STATE_CODES: readonly StateCode[] = MY_STATES.map((s) => s.code);

const STATE_CODE_SET = new Set<string>(STATE_CODES);

export function isStateCode(value: string): value is StateCode {
  return STATE_CODE_SET.has(value);
}

/** `national` plus every state code — the legal values of a holiday scope. */
export type HolidayScope = "national" | StateCode;

export function isHolidayScope(value: string): value is HolidayScope {
  return value === "national" || STATE_CODE_SET.has(value);
}

export function stateName(code: string): string | null {
  return MY_STATES.find((s) => s.code === code)?.name ?? null;
}

/** Every state except the listed ones — how most "national-ish" holidays are
 * actually scoped (New Year's Day is not observed in five states, Deepavali is
 * not observed in Sarawak). */
export function allStatesExcept(...excluded: StateCode[]): StateCode[] {
  return STATE_CODES.filter((c) => !excluded.includes(c));
}
