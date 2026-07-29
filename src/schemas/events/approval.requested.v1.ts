import { z } from "zod";

/**
 * approval.requested.v1 — somebody asked for a decision.
 *
 * `approver_user_id` is the whole point of the payload: PRD-000's notification
 * consumer (S4) turns this event into that user's unread badge, and must not
 * have to query `approvals` to find out who to notify. `requested_by` rides
 * along for the same reason — the consumer needs it to render "X asked you to
 * approve Y" without a second lookup.
 */
export const approvalRequestedV1 = z.object({
  approval_id: z.string(),
  subject_type: z.string(),
  subject_id: z.string(),
  /** Null for programmatic (tenant-API-key) callers, which have no user identity. */
  requested_by: z.string().nullable(),
  approver_user_id: z.string(),
  /** Which strategy picked the approver — useful when debugging a surprising route. */
  resolution_strategy: z.string(),
  /** Levels climbed up the reporting chain to find someone who could act. */
  resolution_hops: z.number().int().nonnegative(),
});
export type ApprovalRequestedV1 = z.infer<typeof approvalRequestedV1>;
