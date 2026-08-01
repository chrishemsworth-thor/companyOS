import { z } from "zod";

/**
 * Expense claims (PRD-006a) — vocabulary and row shapes.
 *
 * Kept dependency-free so the repo, the posting builder, the decision effect and
 * the routes can all import it without cycles. In particular
 * `src/modules/claims/decision.ts` must not reach into `src/modules/approvals/`,
 * because the approvals service imports the decision effect.
 */

/**
 * Claim lifecycle. The transitions live in TRANSITIONS below rather than being
 * spread through the service, the same shape as the approvals primitive and
 * src/modules/support/state-machine.ts.
 */
export const claimStatusSchema = z.enum([
  "draft",
  "submitted",
  "approved",
  "rejected",
  "paid",
  "cancelled",
]);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

/**
 * `rejected` is a resting, editable state, not a terminal one — PRD-006 returns
 * a rejected claim to the employee for resubmission. `approved` is terminal
 * except for payment, because it has hit the append-only ledger.
 */
export const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "rejected", "draft"],
  rejected: ["submitted", "cancelled"],
  approved: ["paid"],
  paid: [],
  cancelled: [],
};

export function canTransitionClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

/**
 * The states in which a claim's own content may still change.
 *
 * PRD-006: "Given an approved claim, when edited, then 409 — approved claims are
 * immutable because they have hit the ledger." `submitted` is excluded too: an
 * approver is reading it, so editing under them would change what they are
 * deciding on. Withdraw first.
 */
export const EDITABLE_CLAIM_STATUSES: readonly ClaimStatus[] = ["draft", "rejected"];

export function isEditableClaimStatus(status: ClaimStatus): boolean {
  return EDITABLE_CLAIM_STATUSES.includes(status);
}

/**
 * `mileage` computes the line amount from distance x the category's per-km rate
 * instead of accepting one from the filer. PRD-006 asks for mileage as a
 * category rather than a separate feature, and this flag is the whole difference.
 */
export const claimCategoryKindSchema = z.enum(["standard", "mileage"]);
export type ClaimCategoryKind = z.infer<typeof claimCategoryKindSchema>;

export interface ClaimCategory {
  category_id: string;
  tenant_id: string;
  code: string;
  name: string;
  /** The GL expense account every line in this category debits. */
  expense_account_id: string;
  kind: ClaimCategoryKind;
  /** Set iff `kind = 'mileage'`. */
  per_km_rate_cents: number | null;
  /** Per-claim, per-category cap. NULL = no limit. */
  limit_cents: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A category joined to its account, which is what the posting and the UI need. */
export interface ClaimCategoryView extends ClaimCategory {
  account_code: string;
  account_name: string;
  account_type: string;
  account_archived_at: string | null;
}

export interface ExpenseClaim {
  claim_id: string;
  tenant_id: string;
  employee_id: string;
  claim_date: string;
  description: string | null;
  currency: string;
  total_cents: number;
  /** Recorded, not posted — the SST Input leg is S12 (SESSION-PLAN C2). */
  tax_cents: number;
  status: ClaimStatus;
  project_id: string | null;
  department_code: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  approval_id: string | null;
  rejection_comment: string | null;
  rejected_at: string | null;
  entry_id: string | null;
  paid_entry_id: string | null;
  payment_reference: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseClaimLine {
  claim_id: string;
  line_no: number;
  category_id: string;
  description: string | null;
  distance_km: number | null;
  amount_cents: number;
  tax_cents: number;
  receipt_file_id: string;
  project_id: string | null;
  department_code: string | null;
}

/**
 * A line as an approver sees it: the money plus enough context to decide without
 * opening anything else. The receipt's filename and content type come along so
 * the card can render an image inline and label a PDF as a download.
 */
export interface ExpenseClaimLineView extends ExpenseClaimLine {
  category_code: string;
  category_name: string;
  category_kind: ClaimCategoryKind;
  account_code: string;
  account_name: string;
  receipt_filename: string | null;
  receipt_content_type: string | null;
  receipt_size_bytes: number | null;
}

/**
 * One category on one claim that is over its configured limit.
 *
 * PRD-006: "Given a category over its limit, then a warning is shown and the
 * claim still submits." So this is advisory data on the response, never an error
 * — a hard block would have an employee quietly not claiming something they are
 * owed, which is the worse failure.
 */
export interface ClaimLimitWarning {
  category_id: string;
  category_code: string;
  category_name: string;
  limit_cents: number;
  claimed_cents: number;
  over_by_cents: number;
}

/** The full claim as `GET /v1/claims/:id` returns it. */
export interface ClaimDetail {
  claim: ExpenseClaim;
  lines: ExpenseClaimLineView[];
  limit_warnings: ClaimLimitWarning[];
}

export interface ClaimLineInput {
  category_id: string;
  description?: string | null;
  /** Required for a mileage category, rejected for any other. */
  distance_km?: number | null;
  /** Required for a standard category, rejected for mileage (it is computed). */
  amount_cents?: number | null;
  tax_cents?: number | null;
  receipt_file_id: string;
  project_id?: string | null;
  department_code?: string | null;
}

export interface CreateClaimInput {
  employee_id?: string | null;
  claim_date: string;
  description?: string | null;
  currency?: string | null;
  project_id?: string | null;
  department_code?: string | null;
  lines: ClaimLineInput[];
}

export interface PatchClaimInput {
  claim_date?: string;
  description?: string | null;
  currency?: string;
  project_id?: string | null;
  department_code?: string | null;
}
