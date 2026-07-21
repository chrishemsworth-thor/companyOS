import { z } from "zod";

/** employee.created.v1 — a new employee record in the People directory. */
export const employeeCreatedV1 = z.object({
  employee_id: z.string(),
  name: z.string(),
  department_id: z.string(),
  email: z.string().optional(),
  team_id: z.string().optional(),
  manager_employee_id: z.string().optional(),
});
export type EmployeeCreatedV1 = z.infer<typeof employeeCreatedV1>;
