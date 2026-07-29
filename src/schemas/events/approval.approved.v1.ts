import { z } from "zod";

/**
 * approval.approved.v1 — the assigned approver (or an admin) approved.
 *
 * Consumers act on this: S5 posts an approved claim to the GL, S7 deducts the
 * leave balance, and S4 notifies the requester. `requested_by` is therefore
 * load-bearing — it is who the notification goes to.
 */
export const approvalApprovedV1 = z.object({
  approval_id: z.string(),
  subject_type: z.string(),
  subject_id: z.string(),
  requested_by: z.string().nullable(),
  approver_user_id: z.string(),
  /** Who actually decided. Differs from `approver_user_id` on an admin override. */
  decided_by: z.string(),
  decided_at: z.string().datetime(),
  comment: z.string().optional(),
});
export type ApprovalApprovedV1 = z.infer<typeof approvalApprovedV1>;
