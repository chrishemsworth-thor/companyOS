import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireRole } from "../middleware/session";
import { pageQuerySchema } from "../pagination";
import {
  createEmployee,
  createTeam,
  getEmployee,
  getTeam,
  listEmployees,
  listTeams,
  PeopleError,
  updateEmployee,
  updateTeam,
} from "../../modules/people/service";

/**
 * People module routes, mounted at /v1/people — one sub-app for both entities
 * (employees + teams) since the module owns the whole HR surface.
 *
 * Reads are open to any authenticated caller (visibility is the department
 * lens's job); writes are the first business-route use of `requireRole` —
 * the "layered in later" gate the session middleware anticipates. System
 * (API-key) callers bypass it, as everywhere else.
 */
export const people = new Hono<AuthedEnv>();

const writeGuard = requireRole("admin", "operator");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO_DATE, "must be YYYY-MM-DD");

const employmentTypeSchema = z.enum(["full_time", "part_time", "contract", "intern"]);
const employeeStatusSchema = z.enum(["active", "inactive"]);

const employeeListQuerySchema = pageQuerySchema.extend({
  department_id: z.string().optional(),
  team_id: z.string().optional(),
  manager_id: z.string().optional(),
  status: employeeStatusSchema.optional(),
});

// department_id stays a plain string here — the service validates it against
// the registry so the error is a consistent PeopleError, not a Zod enum dump.
const createEmployeeSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  job_title: z.string().max(200).optional(),
  department_id: z.string().min(1),
  team_id: z.string().optional(),
  manager_employee_id: z.string().optional(),
  user_id: z.string().optional(),
  employment_type: employmentTypeSchema.optional(),
  status: employeeStatusSchema.optional(),
  start_date: isoDate.optional(),
  end_date: isoDate.optional(),
  location: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
});

const patchEmployeeSchema = z
  .object({
    name: z.string().min(1).max(200),
    email: z.string().email().nullable(),
    phone: z.string().max(50).nullable(),
    job_title: z.string().max(200).nullable(),
    department_id: z.string().min(1),
    team_id: z.string().nullable(),
    manager_employee_id: z.string().nullable(),
    user_id: z.string().nullable(),
    employment_type: employmentTypeSchema,
    status: employeeStatusSchema,
    start_date: isoDate.nullable(),
    end_date: isoDate.nullable(),
    location: z.string().max(200).nullable(),
    notes: z.string().max(5000).nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

const createTeamSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  department_id: z.string().optional(),
  lead_employee_id: z.string().optional(),
});

const patchTeamSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable(),
    department_id: z.string().nullable(),
    lead_employee_id: z.string().nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

function peopleErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof PeopleError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

// ---- Employees ----

people.get("/employees", zValidator("query", employeeListQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  return c.json(await listEmployees(c.env.DB, tenant.tenant_id, c.req.valid("query")));
});

people.post("/employees", writeGuard, zValidator("json", createEmployeeSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const employee = await createEmployee(c.env, tenant.tenant_id, c.req.valid("json"));
    return c.json(employee, 201);
  } catch (err) {
    return peopleErrorResponse(c, err);
  }
});

people.get("/employees/:id", async (c) => {
  const tenant = c.get("tenant");
  const employee = await getEmployee(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!employee) return c.json({ error: "employee not found" }, 404);
  return c.json(employee);
});

people.patch("/employees/:id", writeGuard, zValidator("json", patchEmployeeSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    return c.json(
      await updateEmployee(c.env, tenant.tenant_id, c.req.param("id"), c.req.valid("json")),
    );
  } catch (err) {
    return peopleErrorResponse(c, err);
  }
});

// ---- Teams ----

people.get("/teams", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ teams: await listTeams(c.env.DB, tenant.tenant_id) });
});

people.post("/teams", writeGuard, zValidator("json", createTeamSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const team = await createTeam(c.env, tenant.tenant_id, c.req.valid("json"));
    return c.json(team, 201);
  } catch (err) {
    return peopleErrorResponse(c, err);
  }
});

people.get("/teams/:id", async (c) => {
  const tenant = c.get("tenant");
  const team = await getTeam(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!team) return c.json({ error: "team not found" }, 404);
  return c.json(team);
});

people.patch("/teams/:id", writeGuard, zValidator("json", patchTeamSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    return c.json(await updateTeam(c.env.DB, tenant.tenant_id, c.req.param("id"), c.req.valid("json")));
  } catch (err) {
    return peopleErrorResponse(c, err);
  }
});
