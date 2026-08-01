import type {
  EmploymentType,
  LeavePolicy,
  PolicyBand,
  StatutoryBasis,
  StatutoryWarning,
} from "./types";

/**
 * Employment Act 1955 leave minimums, as amended with effect from 1 January
 * 2023 (Employment (Amendment) Act 2022).
 *
 * **These are a warning, never a floor.** PRD-006 is explicit: *"Employment Act
 * minimums are a seed default and a warning, not an enforced floor — a tenant
 * may have contractual terms above minimum and the system must not fight
 * them."* Nothing in this file rejects anything. `warningsForPolicy()` returns
 * a list that rides along with a successful save, and the caller returns 200.
 *
 * Below-minimum entitlements are also legitimate in practice — probation bands,
 * roles outside the Act's coverage, pro-rated part-time terms — so an enforced
 * floor would be wrong even before you get to the PRD's instruction.
 *
 * **Not compliance guidance.** PRD-006's own open questions ask for the
 * post-2022 figures to be confirmed with HR/legal before they are relied on.
 * They are a starting point for a tenant to edit.
 */

/** A tenure band in the Act: [min, max) completed months → days. */
interface StatutoryBand {
  min_months: number;
  max_months: number | null;
  days: number;
}

/**
 * The Act's own tenure bands: under 2 years, 2 to under 5 years, 5 years and
 * over. Expressed in months to match `monthsOfService`.
 */
const ANNUAL: StatutoryBand[] = [
  { min_months: 0, max_months: 24, days: 8 },
  { min_months: 24, max_months: 60, days: 12 },
  { min_months: 60, max_months: null, days: 16 },
];

/** Sick leave where hospitalisation is NOT necessary. */
const SICK: StatutoryBand[] = [
  { min_months: 0, max_months: 24, days: 14 },
  { min_months: 24, max_months: 60, days: 18 },
  { min_months: 60, max_months: null, days: 22 },
];

/**
 * Hospitalisation leave: up to 60 days a year. The Act frames this as an
 * aggregate that *includes* the outpatient sick-leave entitlement rather than
 * a separate 60 days on top; CompanyOS models it as its own leave type because
 * that is how Malaysian SMEs administer it, and because a single combined
 * bucket cannot express "requires a medical certificate for hospitalisation
 * but not for one day off sick".
 */
const HOSPITALISATION: StatutoryBand[] = [{ min_months: 0, max_months: null, days: 60 }];

/** 98 consecutive days, post-2022 amendment (was 60). */
const MATERNITY: StatutoryBand[] = [{ min_months: 0, max_months: null, days: 98 }];

/**
 * 7 consecutive days, introduced by the 2022 amendment. The Act qualifies it
 * (married, at least 12 months' service, capped at five confinements); the
 * qualifying conditions are HR's to apply, so only the day count is modelled.
 */
const PATERNITY: StatutoryBand[] = [{ min_months: 0, max_months: null, days: 7 }];

const MINIMUMS: Record<StatutoryBasis, StatutoryBand[]> = {
  annual: ANNUAL,
  sick: SICK,
  hospitalisation: HOSPITALISATION,
  maternity: MATERNITY,
  paternity: PATERNITY,
};

export const STATUTORY_BASES = Object.keys(MINIMUMS) as StatutoryBasis[];

/** The statutory minimum for a basis at a given tenure, or null if none applies. */
export function statutoryMinimumDays(
  basis: StatutoryBasis,
  monthsOfService: number,
): number | null {
  const band = MINIMUMS[basis].find(
    (b) => monthsOfService >= b.min_months && (b.max_months === null || monthsOfService < b.max_months),
  );
  return band?.days ?? null;
}

/** Every statutory band for a basis — what the console shows next to a policy. */
export function statutoryBands(basis: StatutoryBasis): readonly StatutoryBand[] {
  return MINIMUMS[basis];
}

function describeBand(band: Pick<PolicyBand, "min_months_service" | "max_months_service">): string {
  const { min_months_service: min, max_months_service: max } = band;
  if (max === null) return `${min}+ months' service`;
  return `${min}-${max} months' service`;
}

function describeType(employmentType: EmploymentType | null): string {
  return employmentType ? employmentType.replace("_", " ") : "all employment types";
}

/**
 * Compare a policy's bands against the Act and describe every shortfall.
 *
 * A policy band is checked at the **weakest tenure it covers** (its lower
 * bound), because that is the point at which the entitlement first applies —
 * checking at the upper bound would flag a band that is perfectly legal for
 * most of its range. A band that straddles a statutory step is checked against
 * every statutory minimum it overlaps, so "12 days for 0-120 months" is warned
 * about for the 5-year population it under-serves.
 */
export function warningsForPolicy(
  basis: StatutoryBasis | null,
  bands: readonly Pick<
    PolicyBand,
    "employment_type" | "min_months_service" | "max_months_service" | "entitlement_days"
  >[],
): StatutoryWarning[] {
  if (!basis) return [];
  const warnings: StatutoryWarning[] = [];

  for (const band of bands) {
    const bandMax = band.max_months_service;
    for (const statutory of MINIMUMS[basis]) {
      // Overlap test on [min, max) windows.
      const startsAfter = statutory.max_months !== null && band.min_months_service >= statutory.max_months;
      const endsBefore = bandMax !== null && bandMax <= statutory.min_months;
      if (startsAfter || endsBefore) continue;
      if (band.entitlement_days >= statutory.days) continue;

      warnings.push({
        code: "below_statutory_minimum",
        basis,
        employment_type: band.employment_type,
        min_months_service: band.min_months_service,
        max_months_service: bandMax,
        entitlement_days: band.entitlement_days,
        statutory_minimum_days: statutory.days,
        message:
          `${band.entitlement_days} days for ${describeType(band.employment_type)} at ` +
          `${describeBand(band)} is below the Employment Act 1955 minimum of ` +
          `${statutory.days} days. Saved as entered — this is a warning, not a limit.`,
      });
    }
  }

  return warnings;
}

/** The same check for a single-employee entitlement override. */
export function warningsForOverride(
  basis: StatutoryBasis | null,
  entitlementDays: number,
  monthsOfService: number,
): StatutoryWarning[] {
  if (!basis) return [];
  const minimum = statutoryMinimumDays(basis, monthsOfService);
  if (minimum === null || entitlementDays >= minimum) return [];
  return [
    {
      code: "below_statutory_minimum",
      basis,
      employment_type: null,
      min_months_service: monthsOfService,
      max_months_service: null,
      entitlement_days: entitlementDays,
      statutory_minimum_days: minimum,
      message:
        `${entitlementDays} days is below the Employment Act 1955 minimum of ${minimum} days ` +
        `at ${monthsOfService} months' service. Saved as entered — this is a warning, not a limit.`,
    },
  ];
}

/** Convenience for a fully loaded policy. */
export function warningsForLoadedPolicy(
  basis: StatutoryBasis | null,
  policy: Pick<LeavePolicy, "bands">,
): StatutoryWarning[] {
  return warningsForPolicy(basis, policy.bands);
}
