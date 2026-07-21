/** People module domain types (source_module: 'people'). */

export type EmploymentType = "full_time" | "part_time" | "contract" | "intern";
export type EmployeeStatus = "active" | "inactive";

export interface Employee {
  employee_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  /** Department registry id (src/departments/registry.ts) — not a DB FK. */
  department_id: string;
  team_id: string | null;
  manager_employee_id: string | null;
  /** Optional link to a console login (users.user_id). */
  user_id: string | null;
  employment_type: EmploymentType;
  status: EmployeeStatus;
  start_date: string | null; // ISO date
  end_date: string | null;
  location: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Team {
  team_id: string;
  name: string;
  description: string | null;
  /** Department registry id — not a DB FK. */
  department_id: string | null;
  lead_employee_id: string | null;
  created_at: string;
  updated_at: string;
}
