import { z } from "zod";

/**
 * claim.rejected.v1 — an approver sent a claim back (PRD-006a).
 *
 * Carries **no `entry_id`, and there is none**: PRD-006's "given a rejected
 * claim, then no ledger entry exists" is structural here, not a check. The
 * rejection branch of the decision effect writes a status and a comment and
 * builds no posting at all.
 *
 * The claim returns to the employee in `rejected` — an editable resting state —
 * and resubmission creates a NEW `approvals` row while this one stands
 * (SESSION-PLAN C8).
 */
export const claimRejectedV1 = z.object({
  claim_id: z.string(),
  employee_id: z.string(),
  approval_id: z.string(),
  decided_by: z.string(),
  decided_at: z.string().datetime(),
  /**
   * Why it came back. Optional at this layer because S3 deliberately kept the
   * primitive permissive — the console requires a comment to reject, the API
   * does not, so a programmatic caller is not blocked by a UI rule.
   */
  comment: z.string().optional(),
});
export type ClaimRejectedV1 = z.infer<typeof claimRejectedV1>;
