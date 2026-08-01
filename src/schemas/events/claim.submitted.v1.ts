import { z } from "zod";

/**
 * claim.submitted.v1 — an employee sent an expense claim for approval (PRD-006a).
 *
 * Emitted by the claims service in the same request that raises the `approvals`
 * row, so a consumer seeing this can rely on `approval_id` resolving.
 *
 * Notifying the approver is **not** this event's job — `approval.requested`
 * already does it, and mapping this one too would put two rows in the approver's
 * bell for one submission. It exists for the audit log and for the PeopleAgent
 * PRD-006 designs for (chasing unsubmitted claims, spotting anomalies).
 */
export const claimSubmittedV1 = z.object({
  claim_id: z.string(),
  employee_id: z.string(),
  /** Who pressed submit — not always whose claim it is. Null for an API-key caller. */
  submitted_by: z.string().nullable(),
  approval_id: z.string(),
  /** Gross, in cents. Equals the sum of the claim's lines. */
  total_cents: z.number().int(),
  /** Captured, not posted until PRD-001's tax work lands (SESSION-PLAN C2). */
  tax_cents: z.number().int(),
  currency: z.string().length(3),
  claim_date: z.string(),
  line_count: z.number().int().positive(),
  project_id: z.string().nullable(),
  department_code: z.string().nullable(),
  /** True when any category on the claim is over its limit — a warning, not a block. */
  over_limit: z.boolean(),
});
export type ClaimSubmittedV1 = z.infer<typeof claimSubmittedV1>;
