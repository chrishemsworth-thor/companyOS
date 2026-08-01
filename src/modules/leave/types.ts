import type { HolidayScope } from "./holidays/states";

/** Leave module domain types (PRD-006b, source_module: 'people'). */

export type EmploymentType = "full_time" | "part_time" | "contract" | "intern";

export type AccrualMethod = "annual_upfront" | "monthly_accrual" | "on_anniversary";

/**
 * Which Employment Act 1955 minimum a leave type is measured against. NULL on
 * the type means no statutory floor exists (compassionate, unpaid) and no
 * warning is ever produced for it.
 */
export type StatutoryBasis = "annual" | "sick" | "hospitalisation" | "maternity" | "paternity";

export type LeaveRequestState = "pending" | "approved" | "rejected" | "cancelled";

export type AdjustmentKind = "carry_forward" | "adjustment" | "encashment";

/**
 * A work week as 7 day fractions, index 0 = Sunday: 1 = full working day,
 * 0.5 = half day, 0 = non-working. Mon-Fri is the default; Kelantan and
 * Terengganu run Sun-Thu; a Saturday half-day is 0.5.
 */
export type WorkWeek = readonly [number, number, number, number, number, number, number];

export const DEFAULT_WORK_WEEK: WorkWeek = [0, 1, 1, 1, 1, 1, 0];

export interface LeaveSettings {
  work_week: WorkWeek;
  defaults_seeded_at: string | null;
}

export interface LeaveType {
  leave_type_id: string;
  code: string;
  name: string;
  description: string | null;
  is_paid: boolean;
  requires_attachment: boolean;
  max_consecutive_days: number | null;
  allows_half_day: boolean;
  carry_forward_allowed: boolean;
  allow_negative_balance: boolean;
  statutory_basis: StatutoryBasis | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyBand {
  band_id: string;
  /** NULL = applies to any employment type. */
  employment_type: EmploymentType | null;
  min_months_service: number;
  /** NULL = open-ended. The window is [min, max). */
  max_months_service: number | null;
  entitlement_days: number;
}

export interface LeavePolicy {
  policy_id: string;
  leave_type_id: string;
  name: string;
  accrual_method: AccrualMethod;
  carry_forward_max_days: number;
  carry_forward_expiry_months: number | null;
  is_default: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  bands: PolicyBand[];
}

export interface EmployeeLeaveProfile {
  employee_id: string;
  /** Malaysian state/FT code, or null for national holidays only. */
  work_state: string | null;
  /** Per-employee override; null means inherit the tenant default. */
  work_week: WorkWeek | null;
}

export interface LeaveAssignment {
  employee_id: string;
  leave_type_id: string;
  policy_id: string;
  entitlement_days_override: number | null;
}

export interface TenantHoliday {
  holiday_id: string;
  holiday_date: string;
  name: string;
  scope: HolidayScope;
  /** false = suppresses the shipped holiday on this date and scope. */
  observed: boolean;
  note: string | null;
}

/** One day off, after the shipped calendar and the tenant's deltas are merged. */
export interface EffectiveHoliday {
  date: string;
  name: string;
  scope: HolidayScope;
  /** Where this entry came from — what makes a tenant edit visible as an edit. */
  source: "shipped" | "tenant";
}

/**
 * A statutory warning. Never blocks a save: PRD-006 is explicit that Employment
 * Act minimums are "a seed default and a warning, not an enforced floor", and a
 * tenant may legitimately hold terms above *or* below them.
 */
export interface StatutoryWarning {
  code: "below_statutory_minimum";
  basis: StatutoryBasis;
  message: string;
  employment_type: EmploymentType | null;
  min_months_service: number;
  max_months_service: number | null;
  entitlement_days: number;
  statutory_minimum_days: number;
}

/** One leave type's balance for one employee in one leave year. */
export interface LeaveBalance {
  leave_type_id: string;
  leave_type_code: string;
  leave_type_name: string;
  leave_year: number;
  /** The window the entitlement is accrued over — calendar year, or the
   * anniversary year for an `on_anniversary` policy. */
  period_start: string;
  period_end: string;
  policy_id: string | null;
  accrual_method: AccrualMethod | null;
  /** Full-year entitlement before pro-rating, straight off the band. */
  full_entitlement_days: number;
  /** After pro-rating for a mid-year join/leave and after accrual to `as_of`. */
  entitlement_days: number;
  /** Carried in from last year, net of anything that has since lapsed. */
  carried_forward_days: number;
  /** Carried days that have lapsed by `as_of` under the expiry rule. */
  carry_forward_expired_days: number;
  /** Manual adjustments and encashments. */
  adjustment_days: number;
  taken_days: number;
  pending_days: number;
  /** entitlement + carried + adjustments − taken − pending. */
  available_days: number;
  /** True when the employee has no explicit assignment and no default policy
   * exists for this type — the balance is zero because nothing is configured,
   * which is a different thing from a zero balance. */
  unconfigured: boolean;
}

export interface CarryForwardResult {
  employee_id: string;
  leave_type_id: string;
  /** Unused days at the close of `from_year`. */
  unused_days: number;
  /** What actually carried, after the cap. */
  carried_days: number;
  cap_days: number;
  /** True when the cap bit — unused exceeded it. */
  capped: boolean;
  /** False when a carry-forward row already existed (idempotent re-run). */
  written: boolean;
}

/**
 * Mirrors PeopleError / SupportError / ApprovalsError: a code, a message, and
 * the status the route returns. 409 for state-machine violations is the
 * codebase convention (src/modules/support/state-machine.ts).
 */
export class LeaveError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_request"
      | "code_taken"
      | "invalid_state"
      | "invalid_work_week"
      | "invalid_employee"
      | "invalid_leave_type"
      | "invalid_policy"
      | "archived",
    message: string,
    readonly httpStatus: 400 | 404 | 409 | 422 = 422,
  ) {
    super(message);
    this.name = "LeaveError";
  }
}
