import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { paginate } from "../../gateway/pagination";
import { DEPARTMENT_IDS } from "../../departments/registry";
import type { Employee, EmploymentType, EmployeeStatus, Team } from "./types";

/**
 * People service (source_module: 'people'). Employees are HR records first —
 * the console login (users row) is an optional link. Same pattern as CRM:
 * D1 writes first, then event emission.
 *
 * Referential rules SQLite can't express live here: department ids are
 * validated against the code registry, the user link's tenant match is
 * service-enforced (users PK is global), and manager cycles are rejected by
 * walking the proposed manager's ancestor chain before every write.
 */

export class PeopleError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_department"
      | "invalid_manager"
      | "manager_cycle"
      | "invalid_team"
      | "email_taken"
      | "user_not_found"
      | "user_already_linked"
      | "name_taken",
    message: string,
    readonly httpStatus: 404 | 409 | 422 = 422,
  ) {
    super(message);
    this.name = "PeopleError";
  }
}

function assertDepartment(departmentId: string): void {
  // Planned departments are allowed — HR placement is independent of whether
  // that department's module has shipped.
  if (!DEPARTMENT_IDS.includes(departmentId)) {
    throw new PeopleError("invalid_department", `unknown department ${departmentId}`);
  }
}

// ---- Teams ----

const TEAM_COLUMNS =
  "team_id, name, description, department_id, lead_employee_id, created_at, updated_at";

export async function getTeam(
  db: D1Database,
  tenantId: string,
  teamId: string,
): Promise<Team | null> {
  return db
    .prepare(`SELECT ${TEAM_COLUMNS} FROM teams WHERE tenant_id = ? AND team_id = ?`)
    .bind(tenantId, teamId)
    .first<Team>();
}

export async function listTeams(db: D1Database, tenantId: string): Promise<Team[]> {
  const { results } = await db
    .prepare(`SELECT ${TEAM_COLUMNS} FROM teams WHERE tenant_id = ? ORDER BY name`)
    .bind(tenantId)
    .all<Team>();
  return results;
}

async function assertTeamName(db: D1Database, tenantId: string, name: string): Promise<void> {
  const existing = await db
    .prepare("SELECT team_id FROM teams WHERE tenant_id = ? AND name = ?")
    .bind(tenantId, name)
    .first();
  if (existing) throw new PeopleError("name_taken", `team ${name} already exists`, 409);
}

async function assertLead(db: D1Database, tenantId: string, employeeId: string): Promise<void> {
  const lead = await getEmployee(db, tenantId, employeeId);
  if (!lead) throw new PeopleError("invalid_manager", `employee ${employeeId} not found`);
}

export async function createTeam(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: {
    name: string;
    description?: string;
    department_id?: string;
    lead_employee_id?: string;
  },
): Promise<Team> {
  if (input.department_id) assertDepartment(input.department_id);
  if (input.lead_employee_id) await assertLead(env.DB, tenantId, input.lead_employee_id);
  await assertTeamName(env.DB, tenantId, input.name);

  const teamId = `team_${ulid()}`;
  await env.DB.prepare(
    `INSERT INTO teams (team_id, tenant_id, name, description, department_id, lead_employee_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      teamId,
      tenantId,
      input.name,
      input.description ?? null,
      input.department_id ?? null,
      input.lead_employee_id ?? null,
    )
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "team.created",
      source_module: "people",
      tenant_id: tenantId,
      payload: {
        team_id: teamId,
        name: input.name,
        ...(input.department_id ? { department_id: input.department_id } : {}),
      },
    }),
  );

  return (await getTeam(env.DB, tenantId, teamId)) as Team;
}

export async function updateTeam(
  db: D1Database,
  tenantId: string,
  teamId: string,
  patch: {
    name?: string;
    description?: string | null;
    department_id?: string | null;
    lead_employee_id?: string | null;
  },
): Promise<Team> {
  const team = await getTeam(db, tenantId, teamId);
  if (!team) throw new PeopleError("not_found", "team not found", 404);
  if (patch.department_id) assertDepartment(patch.department_id);
  if (patch.lead_employee_id) await assertLead(db, tenantId, patch.lead_employee_id);
  if (patch.name && patch.name !== team.name) await assertTeamName(db, tenantId, patch.name);

  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const field of ["name", "description", "department_id", "lead_employee_id"] as const) {
    if (patch[field] !== undefined) {
      sets.push(`${field} = ?`);
      binds.push(patch[field]);
    }
  }
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  await db
    .prepare(`UPDATE teams SET ${sets.join(", ")} WHERE tenant_id = ? AND team_id = ?`)
    .bind(...binds, tenantId, teamId)
    .run();
  return (await getTeam(db, tenantId, teamId)) as Team;
}

// ---- Employees ----

const EMPLOYEE_COLUMNS =
  "employee_id, name, email, phone, job_title, department_id, team_id, manager_employee_id, " +
  "user_id, employment_type, status, start_date, end_date, location, notes, created_at, updated_at";

export async function getEmployee(
  db: D1Database,
  tenantId: string,
  employeeId: string,
): Promise<Employee | null> {
  return db
    .prepare(`SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE tenant_id = ? AND employee_id = ?`)
    .bind(tenantId, employeeId)
    .first<Employee>();
}

export async function listEmployees(
  db: D1Database,
  tenantId: string,
  filter: {
    department_id?: string;
    team_id?: string;
    manager_id?: string;
    status?: EmployeeStatus;
    cursor?: string;
    limit: number;
  },
): Promise<{ employees: Employee[]; next_cursor: string | null }> {
  const clauses = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (filter.department_id) {
    clauses.push("department_id = ?");
    binds.push(filter.department_id);
  }
  if (filter.team_id) {
    clauses.push("team_id = ?");
    binds.push(filter.team_id);
  }
  if (filter.manager_id) {
    clauses.push("manager_employee_id = ?");
    binds.push(filter.manager_id);
  }
  if (filter.status) {
    clauses.push("status = ?");
    binds.push(filter.status);
  }
  if (filter.cursor) {
    clauses.push("employee_id > ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE ${clauses.join(" AND ")}
       ORDER BY employee_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<Employee>();
  const { items, next_cursor } = paginate(results, filter.limit, "employee_id");
  return { employees: items, next_cursor };
}

async function assertEmail(
  db: D1Database,
  tenantId: string,
  email: string,
  excludeEmployeeId?: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT employee_id FROM employees WHERE tenant_id = ? AND email = ?")
    .bind(tenantId, email)
    .first<{ employee_id: string }>();
  if (row && row.employee_id !== excludeEmployeeId) {
    throw new PeopleError("email_taken", `an employee with email ${email} already exists`, 409);
  }
}

async function assertTeam(db: D1Database, tenantId: string, teamId: string): Promise<void> {
  const team = await getTeam(db, tenantId, teamId);
  if (!team) throw new PeopleError("invalid_team", `team ${teamId} not found`);
}

async function assertUserLink(
  db: D1Database,
  tenantId: string,
  userId: string,
  excludeEmployeeId?: string,
): Promise<void> {
  const user = await db
    .prepare("SELECT tenant_id FROM users WHERE user_id = ?")
    .bind(userId)
    .first<{ tenant_id: string }>();
  if (!user || user.tenant_id !== tenantId) {
    throw new PeopleError("user_not_found", `user ${userId} not found`);
  }
  const linked = await db
    .prepare("SELECT employee_id FROM employees WHERE tenant_id = ? AND user_id = ?")
    .bind(tenantId, userId)
    .first<{ employee_id: string }>();
  if (linked && linked.employee_id !== excludeEmployeeId) {
    throw new PeopleError("user_already_linked", `user ${userId} is already linked to an employee`, 409);
  }
}

/**
 * Reject reporting cycles before they're written: walk up from the proposed
 * manager through its ancestor chain; if the employee being assigned appears,
 * the assignment would close a loop. Self-management is also caught by the
 * table CHECK, but checking here gives a consistent 422. Depth-capped
 * defensively in case a cycle ever slips in via direct D1 writes.
 */
async function assertNoManagerCycle(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  managerId: string,
): Promise<void> {
  if (managerId === employeeId) {
    throw new PeopleError("invalid_manager", "an employee cannot manage themselves");
  }
  const row = await db
    .prepare(
      `WITH RECURSIVE chain(id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT e.manager_employee_id, chain.depth + 1
         FROM employees e JOIN chain ON e.employee_id = chain.id
         WHERE e.tenant_id = ? AND e.manager_employee_id IS NOT NULL AND chain.depth < 100
       )
       SELECT 1 AS hit FROM chain WHERE id = ? LIMIT 1`,
    )
    .bind(managerId, tenantId, employeeId)
    .first<{ hit: number }>();
  if (row) {
    throw new PeopleError("manager_cycle", "assignment would create a reporting cycle");
  }
}

async function assertManager(
  db: D1Database,
  tenantId: string,
  employeeId: string | undefined,
  managerId: string,
): Promise<void> {
  const manager = await getEmployee(db, tenantId, managerId);
  if (!manager) throw new PeopleError("invalid_manager", `manager ${managerId} not found`);
  if (employeeId) await assertNoManagerCycle(db, tenantId, employeeId, managerId);
}

export interface EmployeeInput {
  name: string;
  email?: string;
  phone?: string;
  job_title?: string;
  department_id: string;
  team_id?: string;
  manager_employee_id?: string;
  user_id?: string;
  employment_type?: EmploymentType;
  status?: EmployeeStatus;
  start_date?: string;
  end_date?: string;
  location?: string;
  notes?: string;
}

export async function createEmployee(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: EmployeeInput,
): Promise<Employee> {
  assertDepartment(input.department_id);
  if (input.email) await assertEmail(env.DB, tenantId, input.email);
  if (input.team_id) await assertTeam(env.DB, tenantId, input.team_id);
  if (input.manager_employee_id) {
    await assertManager(env.DB, tenantId, undefined, input.manager_employee_id);
  }
  if (input.user_id) await assertUserLink(env.DB, tenantId, input.user_id);

  const employeeId = `emp_${ulid()}`;
  await env.DB.prepare(
    `INSERT INTO employees (employee_id, tenant_id, name, email, phone, job_title, department_id,
       team_id, manager_employee_id, user_id, employment_type, status, start_date, end_date, location, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      employeeId,
      tenantId,
      input.name,
      input.email ?? null,
      input.phone ?? null,
      input.job_title ?? null,
      input.department_id,
      input.team_id ?? null,
      input.manager_employee_id ?? null,
      input.user_id ?? null,
      input.employment_type ?? "full_time",
      input.status ?? "active",
      input.start_date ?? null,
      input.end_date ?? null,
      input.location ?? null,
      input.notes ?? null,
    )
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "employee.created",
      source_module: "people",
      tenant_id: tenantId,
      payload: {
        employee_id: employeeId,
        name: input.name,
        department_id: input.department_id,
        ...(input.email ? { email: input.email } : {}),
        ...(input.team_id ? { team_id: input.team_id } : {}),
        ...(input.manager_employee_id ? { manager_employee_id: input.manager_employee_id } : {}),
      },
    }),
  );

  return (await getEmployee(env.DB, tenantId, employeeId)) as Employee;
}

const EMPLOYEE_PATCH_FIELDS = [
  "name",
  "email",
  "phone",
  "job_title",
  "department_id",
  "team_id",
  "manager_employee_id",
  "user_id",
  "employment_type",
  "status",
  "start_date",
  "end_date",
  "location",
  "notes",
] as const;

export type EmployeePatch = Partial<{
  [K in (typeof EMPLOYEE_PATCH_FIELDS)[number]]: string | null;
}>;

export async function updateEmployee(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  employeeId: string,
  patch: EmployeePatch,
): Promise<Employee> {
  const existing = await getEmployee(env.DB, tenantId, employeeId);
  if (!existing) throw new PeopleError("not_found", "employee not found", 404);

  if (patch.department_id) assertDepartment(patch.department_id);
  if (patch.email) await assertEmail(env.DB, tenantId, patch.email, employeeId);
  if (patch.team_id) await assertTeam(env.DB, tenantId, patch.team_id);
  if (patch.manager_employee_id) {
    await assertManager(env.DB, tenantId, employeeId, patch.manager_employee_id);
  }
  if (patch.user_id) await assertUserLink(env.DB, tenantId, patch.user_id, employeeId);

  const sets: string[] = [];
  const binds: unknown[] = [];
  const changed: string[] = [];
  for (const field of EMPLOYEE_PATCH_FIELDS) {
    if (patch[field] !== undefined) {
      sets.push(`${field} = ?`);
      binds.push(patch[field]);
      changed.push(field);
    }
  }
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  await env.DB.prepare(
    `UPDATE employees SET ${sets.join(", ")} WHERE tenant_id = ? AND employee_id = ?`,
  )
    .bind(...binds, tenantId, employeeId)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "employee.updated",
      source_module: "people",
      tenant_id: tenantId,
      payload: { employee_id: employeeId, changed },
    }),
  );

  return (await getEmployee(env.DB, tenantId, employeeId)) as Employee;
}
