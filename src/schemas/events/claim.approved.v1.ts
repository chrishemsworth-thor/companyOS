import { z } from "zod";

/**
 * claim.approved.v1 — a claim was approved and posted to the GL (PRD-006a).
 *
 * Emitted after the batch that recorded the approval decision, wrote the claim's
 * `approved` status and inserted the journal entry — all three in one D1
 * transaction. So `entry_id` on this payload is guaranteed to resolve: there is
 * no window in which this event exists and the entry does not.
 *
 * `entry_id` travels precisely so a consumer never has to re-derive which entry
 * belonged to which claim. (It could be recovered as `source_id = claim_id`, but
 * making a consumer reconstruct a link the emitter already knew is how the two
 * drift apart.)
 */
export const claimApprovedV1 = z.object({
  claim_id: z.string(),
  employee_id: z.string(),
  approval_id: z.string(),
  /** The user who decided. Differs from the assigned approver on an admin override. */
  decided_by: z.string(),
  decided_at: z.string().datetime(),
  total_cents: z.number().int(),
  currency: z.string().length(3),
  /** The `Dr {category expense} / Cr Employee Reimbursements Payable` entry. */
  entry_id: z.string(),
});
export type ClaimApprovedV1 = z.infer<typeof claimApprovedV1>;
