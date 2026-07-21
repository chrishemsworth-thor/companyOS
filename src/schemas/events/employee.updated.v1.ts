import { z } from "zod";

/** employee.updated.v1 — an employee record changed; `changed` lists the fields. */
export const employeeUpdatedV1 = z.object({
  employee_id: z.string(),
  changed: z.array(z.string()),
});
export type EmployeeUpdatedV1 = z.infer<typeof employeeUpdatedV1>;
