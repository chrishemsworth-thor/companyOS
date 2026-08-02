import { z } from "zod";

/**
 * leave.rejected.v1 — the approver refused the request.
 *
 * The days go straight back into the employee's available balance, because
 * balance is derived and `rejected` is not a consuming state (see
 * src/modules/people/leave/service.ts). No compensating write is needed or
 * emitted.
 *
 * `comment` is carried because "why was this refused" is the entire reason the
 * employee opens the notification. S4's consumer already puts the
 * `approval.rejected` comment in the notification body, so this field exists for
 * domain consumers (a future PeopleAgent, an export) rather than for the badge.
 */
export const leaveRejectedV1 = z.object({
  leave_request_id: z.string(),
  employee_id: z.string(),
  employee_user_id: z.string().nullable(),
  leave_type_code: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  working_days: z.number(),
  rejected_by: z.string().nullable(),
  decided_at: z.string(),
  comment: z.string().nullable(),
});
export type LeaveRejectedV1 = z.infer<typeof leaveRejectedV1>;
