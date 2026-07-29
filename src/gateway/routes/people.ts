import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireCapability } from "../middleware/capability";
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
import { createUser, getUserAuthState, ROLES, UserError } from "../../auth/users";
import { issueAndSendInvite } from "../../auth/invites";

/**
 * People module routes, mounted at /v1/people — one sub-app for both entities
 * (employees + teams) since the module owns the whole HR surface.
 *
 * Gating comes from the mount table in `src/index.ts`: reads need
 * `people:read` and writes `people:write` (see src/auth/capabilities.ts). The
 * directory carries employment terms and HR notes, so it is *not* readable by
 * every login — `finance`, `support` and the self-service `employee` tier get a
 * 403 here, and an employee reads their own record via /v1/me/employee instead.
 * System (API-key) callers bypass the matrix, as everywhere else.
 */
export const people = new Hono<AuthedEnv>();

// Granting console access creates a login with a role, which is tenant
// administration rather than an HR edit — so it is held to the /v1/users bar
// (admin) rather than the operator-level `people:write` the router carries.
const inviteGuard = requireCapability("admin:write");

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

people.post("/employees", zValidator("json", createEmployeeSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const employee = await createEmployee(c.env, tenant.tenant_id, c.req.valid("json"));
    return c.json(employee, 201);
  } catch (err) {
    return peopleErrorResponse(c, err);
  }
});

const inviteEmployeeSchema = z
  .object({ role: z.enum(ROLES).optional() })
  .optional()
  .default({});

/**
 * Grant an existing employee access to the console: create the linked login
 * (employees.user_id) and email them a single-use invite to set their own
 * password. Deliberately explicit rather than automatic on employee creation —
 * not every employee needs a login, and the platform role can't be inferred
 * from an HR record.
 *
 * Re-invitable while the login is still pending, so this doubles as "resend".
 */
people.post(
  "/employees/:id/invite",
  inviteGuard,
  zValidator("json", inviteEmployeeSchema),
  async (c) => {
    const tenant = c.get("tenant");
    const actor = c.get("user");
    const inviterUserId = actor?.type === "user" ? actor.id : undefined;
    const { role } = c.req.valid("json");

    const employee = await getEmployee(c.env.DB, tenant.tenant_id, c.req.param("id"));
    if (!employee) return c.json({ error: "employee not found", code: "not_found" }, 404);
    if (!employee.email) {
      return c.json(
        { error: "employee has no email address to invite", code: "no_email" },
        422,
      );
    }
    if (employee.status !== "active") {
      return c.json(
        { error: "cannot invite an inactive employee", code: "employee_inactive" },
        422,
      );
    }

    // Already linked to a login: re-issue while it is still pending, otherwise
    // there is nothing to invite.
    if (employee.user_id) {
      const state = await getUserAuthState(c.env.DB, tenant.tenant_id, {
        user_id: employee.user_id,
      });
      if (!state) {
        return c.json(
          { error: "linked login no longer exists", code: "user_not_found" },
          409,
        );
      }
      if (state.status === "disabled") {
        return c.json({ error: "linked login is disabled", code: "user_disabled" }, 409);
      }
      if (state.has_password) {
        return c.json(
          { error: "employee already has console access", code: "already_has_access" },
          409,
        );
      }
      const invite = await issueAndSendInvite(c.env, tenant.tenant_id, {
        user_id: state.user_id,
        email: state.email,
        inviter_user_id: inviterUserId,
      });
      return c.json({ employee, invite });
    }

    let user;
    try {
      user = await createUser(c.env.DB, {
        tenant_id: tenant.tenant_id,
        email: employee.email,
        display_name: employee.name,
        role,
      });
    } catch (err) {
      // A login already exists on this email but isn't linked to this
      // employee — linking is a deliberate act, so point them at it rather
      // than guessing that the two records are the same person.
      if (err instanceof UserError && err.code === "email_taken") {
        return c.json(
          {
            error: `a login already exists for ${employee.email}; link it from the employee's Edit form`,
            code: "email_taken",
          },
          409,
        );
      }
      throw err;
    }

    // Link through the service so employee.updated is emitted for the audit log.
    const linked = await updateEmployee(c.env, tenant.tenant_id, employee.employee_id, {
      user_id: user.user_id,
    });
    const invite = await issueAndSendInvite(c.env, tenant.tenant_id, {
      user_id: user.user_id,
      email: user.email,
      inviter_user_id: inviterUserId,
    });
    return c.json({ employee: linked, user, invite }, 201);
  },
);

people.get("/employees/:id", async (c) => {
  const tenant = c.get("tenant");
  const employee = await getEmployee(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!employee) return c.json({ error: "employee not found" }, 404);
  return c.json(employee);
});

people.patch("/employees/:id", zValidator("json", patchEmployeeSchema), async (c) => {
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

people.post("/teams", zValidator("json", createTeamSchema), async (c) => {
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

people.patch("/teams/:id", zValidator("json", patchTeamSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    return c.json(await updateTeam(c.env.DB, tenant.tenant_id, c.req.param("id"), c.req.valid("json")));
  } catch (err) {
    return peopleErrorResponse(c, err);
  }
});
