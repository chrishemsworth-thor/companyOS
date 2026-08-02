import { z } from "zod";

/**
 * leave.cancelled.v1 — the leave is gone, by withdrawal rather than refusal.
 *
 * Three routes produce it, and `previous_state` is what tells them apart:
 *
 *  - `pending` — the employee withdrew a request nobody had decided yet. The
 *    approval is cancelled through the primitive, which emits nothing of its own
 *    (a second `approval.cancelled` would have S4's consumer telling an approver
 *    about work that simply evaporated), so this event is the only record on the
 *    bus.
 *  - `approved` — an admin cancelled approved future leave outright. **No
 *    approval event exists for this path at all**, which is why it is the one
 *    `leave.*` event registered in the notification map: without it the employee
 *    would find their leave gone and never be told.
 *  - `cancellation_pending` — the employee asked to hand approved leave back and
 *    the approver agreed. Emitted by the decision consumer.
 *
 * `cancelled_by` is nullable for the same reason `requested_by` is: a
 * programmatic caller has no user identity. It is also how the notification
 * mapper decides whether to notify — there is no point telling somebody about
 * their own action.
 */
export const leaveCancelledV1 = z.object({
  leave_request_id: z.string(),
  employee_id: z.string(),
  employee_user_id: z.string().nullable(),
  leave_type_code: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  working_days: z.number(),
  previous_state: z.enum(["pending", "approved", "cancellation_pending"]),
  cancelled_by: z.string().nullable(),
});
export type LeaveCancelledV1 = z.infer<typeof leaveCancelledV1>;
