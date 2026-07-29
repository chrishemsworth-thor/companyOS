import { z } from "zod";

/**
 * approval.nudged.v1 — the requester chased their approver.
 *
 * Exists because of SESSION-PLAN conflict C4. PRD-007's nudge is a
 * user-initiated action from the inbox, so the obvious implementation inserts a
 * notification row straight from the route — which breaks PRD-000's rule that
 * only the event consumer writes that table. Emitting instead keeps one writer:
 * the same consumer that handles `approval.requested` maps this to a row.
 *
 * The 24h rate limit is NOT here. It lives in the service before the emit
 * (src/modules/approvals/nudge.ts), because an event on the bus is a statement
 * that something happened — a suppressed nudge did not happen and should not be
 * on the log at all.
 *
 * Payload mirrors `approval.requested` so the consumer's two mappers read the
 * same fields: `approver_user_id` is who gets told, `requested_by` is who did
 * the chasing.
 */
export const approvalNudgedV1 = z.object({
  approval_id: z.string(),
  subject_type: z.string(),
  subject_id: z.string(),
  /**
   * Who nudged. Non-nullable, unlike the other `approval.*` payloads: nudging is
   * a console action restricted to the requester, so a programmatic caller with
   * no user identity can never produce this event.
   */
  requested_by: z.string(),
  approver_user_id: z.string(),
  /** How long the request had been waiting, for "chased after 6 days" reporting. */
  pending_hours: z.number().nonnegative(),
});
export type ApprovalNudgedV1 = z.infer<typeof approvalNudgedV1>;
