import { z } from "zod";

/**
 * leave.requested.v1 — an employee (or HR on their behalf) filed leave.
 *
 * `employee_user_id` rides along beside `employee_id` because consumers deal in
 * users, not employees: a notification goes to a login, and `employees.user_id`
 * is nullable, so a consumer that had only the employee id would need a database
 * lookup just to discover there is nobody to tell. Same reasoning as
 * `approval.requested.v1` carrying both `requested_by` and `approver_user_id`.
 *
 * `approval_id` links the domain fact to the primitive's audit fact, so anything
 * reading the log can join a leave request to the decision that resolved it
 * without querying either table.
 */
export const leaveRequestedV1 = z.object({
  leave_request_id: z.string(),
  employee_id: z.string(),
  /** Null when the employee has no console login. */
  employee_user_id: z.string().nullable(),
  leave_type_code: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  /** Working days as computed at submission — fractional for half days. */
  working_days: z.number(),
  approval_id: z.string(),
  /** Null for programmatic (tenant-API-key) callers, which have no user identity. */
  requested_by: z.string().nullable(),
});
export type LeaveRequestedV1 = z.infer<typeof leaveRequestedV1>;
