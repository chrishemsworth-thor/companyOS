import { z } from "zod";

/**
 * Leave requests (PRD-006c) — vocabulary and row shapes.
 *
 * Dependency-free so the policy port, the service, the consumer and the route
 * can all import it without cycles. Same shape as
 * src/modules/approvals/types.ts and src/modules/notifications/types.ts.
 */

/**
 * Request lifecycle. Constrained in SQL as well as here (see
 * migrations/0026_leave_requests.sql) because — unlike `approvals.subject_type`
 * or `files.purpose` — this is the module's own vocabulary and no other module
 * extends it.
 *
 *   pending              → approved | rejected | cancelled
 *   approved             → cancellation_pending | cancelled (admin only)
 *   cancellation_pending → cancelled | approved (re-approval rejected)
 *   rejected, cancelled  → terminal
 */
export const leaveRequestStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "cancellation_pending",
  "cancelled",
]);
export type LeaveRequestState = z.infer<typeof leaveRequestStateSchema>;

/**
 * States that consume balance.
 *
 * `pending` counts because PRD-006 is explicit that "pending requests must
 * reduce available balance or employees will over-book", and
 * `cancellation_pending` counts because the leave is still approved until
 * somebody agrees to give it back. Those two plus `approved` are exactly the
 * states in which the days are not the employee's to spend again.
 */
export const CONSUMING_STATES: readonly LeaveRequestState[] = [
  "pending",
  "approved",
  "cancellation_pending",
];

/**
 * States that block a second overlapping request from the same employee
 * (PRD-006: "given overlapping dates with an existing request from the same
 * employee, then 409"). Identical to the consuming set — a rejected or cancelled
 * request is not in anyone's way — but named separately because they answer
 * different questions and one may legitimately change without the other.
 */
export const BLOCKING_STATES: readonly LeaveRequestState[] = CONSUMING_STATES;

export interface LeaveRequest {
  leave_request_id: string;
  tenant_id: string;
  employee_id: string;
  leave_type_code: string;
  start_date: string;
  end_date: string;
  /** 0 | 1 — SQLite has no boolean. Normalised for the API by `toView()`. */
  start_half_day: number;
  end_half_day: number;
  working_days: number;
  reason: string | null;
  attachment_file_id: string | null;
  state: LeaveRequestState;
  approval_id: string | null;
  decided_at: string | null;
  cancelled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The API shape: the row with the SQLite integers turned into real booleans and
 * the employee's name joined on.
 *
 * The name is here because every consumer needs it and none of them can get it
 * cheaply — the approval card renders "Aisha Rahman", the team calendar renders
 * a column per person, and neither holds `people:read` in the general case, so
 * they cannot resolve an `emp_...` themselves. `GET /v1/meta/users` only covers
 * users, and an employee need not have a login.
 */
export interface LeaveRequestView
  extends Omit<LeaveRequest, "start_half_day" | "end_half_day" | "tenant_id"> {
  start_half_day: boolean;
  end_half_day: boolean;
  employee_name: string;
  /** The employee's console login, when they have one. Null otherwise. */
  employee_user_id: string | null;
}

/**
 * A leave type as the rest of the module sees it.
 *
 * This is the contract with S6: whatever `leave_types` ends up looking like,
 * src/modules/people/leave/policy-port.ts maps it onto this. Every field is one
 * PRD-006 names for `leave_types`, minus carry-forward rules — those affect
 * entitlement, not requests, so they live behind `getEntitlement()` instead.
 */
export interface LeaveType {
  code: string;
  name: string;
  paid: boolean;
  /** Medical certificates. Submission without a file is a 422. */
  requires_attachment: boolean;
  /** Null when the type sets no ceiling. */
  max_consecutive_days: number | null;
  allows_half_day: boolean;
  /**
   * Whether a request may exceed available balance. True for unpaid leave, whose
   * whole point is that there is no entitlement to run down. PRD-006's blocking
   * criterion carries this as its stated exception.
   */
  allows_negative_balance: boolean;
}

/** Entitlement for one employee, one leave type, one year. S6's half of the sum. */
export interface Entitlement {
  /** Days granted for the year, already pro-rated for a mid-year join by S6. */
  days: number;
  /** Days brought forward from last year, already capped by S6. */
  carry_forward_days: number;
  /**
   * Where the numbers came from. `default` means S6's tables were unreadable and
   * the provisional fallback applied — surfaced on the API so a console can say
   * "policy not configured" rather than presenting a guess as policy.
   */
  source: "policy" | "default";
}

/** One leave type's balance, as `GET /v1/leave/balances` returns it. */
export interface LeaveBalance {
  leave_type_code: string;
  leave_type_name: string;
  entitlement_days: number;
  carry_forward_days: number;
  /** Working days on `approved` requests in the year. */
  taken_days: number;
  /** Working days on `pending` + `cancellation_pending` requests in the year. */
  pending_days: number;
  /** entitlement + carry_forward − taken − pending. May be negative. */
  available_days: number;
  entitlement_source: "policy" | "default";
}

/**
 * The applicable working-day calendar for one employee.
 *
 * S6 owns both halves: the work week (Mon–Fri by default, but Kelantan and
 * Terengganu run Sun–Thu) and the public holidays for the employee's state.
 */
export interface WorkCalendar {
  /** Working weekdays as `Date.getUTCDay()` values — 0 = Sunday. */
  workDays: ReadonlySet<number>;
  /** `YYYY-MM-DD` dates that are not worked. */
  holidays: ReadonlySet<string>;
  source: "policy" | "default";
}

/**
 * Another team member's approved leave overlapping a proposed request.
 *
 * A warning, never a block (PRD-006: "warn, do not block"). This is the
 * manager's actual question at the moment of approving — "will anyone be left
 * covering this" — which is why it rides on both the preview response and the
 * approval card.
 */
export interface TeamOverlap {
  leave_request_id: string;
  employee_id: string;
  employee_name: string;
  leave_type_code: string;
  start_date: string;
  end_date: string;
  working_days: number;
  state: LeaveRequestState;
}

/**
 * What `POST /v1/leave/preview` answers, and what the submit path checks against.
 *
 * PRD-006 requires the computed working days be shown *before* submission, so
 * the preview is a first-class response rather than a side effect of a failed
 * submit. `blockers` being empty is exactly the condition under which submit
 * succeeds — the same function produces both, so the console can never show a
 * green preview for a request the API will refuse.
 */
export interface LeavePreview {
  leave_type_code: string;
  start_date: string;
  end_date: string;
  start_half_day: boolean;
  end_half_day: boolean;
  working_days: number;
  /** Calendar days in the span, so a console can say "5 of 7 days deducted". */
  calendar_days: number;
  /** Non-working days excluded from the count, with why. */
  excluded_days: Array<{ date: string; reason: "non_working_day" | "public_holiday" }>;
  balance: LeaveBalance;
  /** Available balance if this request were approved. PRD-006c's card field. */
  balance_after_days: number;
  /** Warnings, all non-blocking. */
  team_overlaps: TeamOverlap[];
  warnings: LeaveWarning[];
  /** Reasons submit would be refused. Empty means submit will succeed. */
  blockers: LeaveBlocker[];
  calendar_source: "policy" | "default";
}

export interface LeaveWarning {
  code: "team_overlap" | "policy_not_configured" | "unpaid_leave";
  message: string;
}

export interface LeaveBlocker {
  code:
    | "unknown_leave_type"
    | "insufficient_balance"
    | "attachment_required"
    | "half_day_not_allowed"
    | "max_consecutive_days"
    | "no_working_days"
    | "overlapping_request";
  message: string;
  /** Present on `insufficient_balance`. */
  shortfall_days?: number;
  available_days?: number;
  /** Present on `overlapping_request`. */
  conflicting_leave_request_id?: string;
}
