import { z } from "zod";

/**
 * leave.approved.v1 — the leave stands.
 *
 * Emitted for two transitions, not one: `pending → approved` (granted) and
 * `cancellation_pending → approved` (a cancellation was refused, so the
 * previously approved leave remains). Both leave the employee holding approved
 * leave, and the event describes what happened to the leave rather than which
 * button somebody pressed.
 *
 * `approved_by` is nullable because a decision can be recorded by a programmatic
 * caller; in practice the approvals route requires a user session, so it is
 * populated on every path that exists today.
 */
export const leaveApprovedV1 = z.object({
  leave_request_id: z.string(),
  employee_id: z.string(),
  employee_user_id: z.string().nullable(),
  leave_type_code: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  working_days: z.number(),
  approved_by: z.string().nullable(),
  decided_at: z.string(),
});
export type LeaveApprovedV1 = z.infer<typeof leaveApprovedV1>;
