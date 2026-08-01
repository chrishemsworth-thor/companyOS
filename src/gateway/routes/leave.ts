import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AuthedEnv } from "../middleware/auth";
import { paginate, pageQuerySchema } from "../pagination";
import { can } from "../../auth/capabilities";
import { getEmployeeByUserId } from "../../modules/people/service";
import { getApproval, listApprovals } from "../../modules/approvals/service";
import {
  cancelLeaveRequest,
  getBalances,
  getLeaveRequest,
  listLeaveRequests,
  previewLeaveRequest,
  submitLeaveRequest,
  LeaveError,
} from "../../modules/people/leave/service";
import { getLeaveTypes } from "../../modules/people/leave/policy-port";
import { isIsoDate, yearOf } from "../../modules/people/leave/calendar";
import { leaveRequestStateSchema } from "../../modules/people/leave/types";

/**
 * Leave HTTP surface (PRD-006c), mounted at `/v1/leave` against the **`self`**
 * capability module.
 *
 * ## Why `self`, and why not `/v1/me/leave`
 *
 * PRD-006 says leave routes "belong under `/v1/me` against the `self` module".
 * The module is right and is what actually matters — it is what lets an
 * `employee` login, which 403s everywhere else under `/v1`, file and track its
 * own leave without holding a single business capability.
 *
 * The path is not `/v1/me`, deliberately. A leave request has to be readable by
 * its **approver**, who is by definition not the caller, and `src/gateway/routes/
 * me.ts` holds as an invariant that ownership is "resolved from the session's
 * user id, never from a path parameter, so there is no id to tamper with: you can
 * only ever read your own record". Serving somebody else's leave request from
 * `/v1/me/...` would quietly break that promise for every other route in the
 * file. So the rows live at `/v1/leave` with per-row authorization, which is
 * exactly the pattern the mount table already endorses for this axis:
 * *"authorization is per-row inside the services ('is this row yours'), never
 * per-role"*.
 *
 * ## Who may see what
 *
 * One predicate, `mayReadRequest()`, applied everywhere:
 *
 *  - the employee the leave is about (via their linked login), or
 *  - **anyone holding a live approval on it** — this is what makes the approvals
 *    inbox card work for a manager whose role grants no `people:read`, and it is
 *    scoped to that one subject id rather than to leave in general, or
 *  - a `people:read` holder (HR, operators), or an admin.
 *
 * A caller failing all four gets 404, not 403: a 403 would confirm the id exists.
 */

export const leave = new Hono<AuthedEnv>();

function leaveErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof LeaveError) {
    return c.json({ error: err.message, code: err.code, ...(err.detail ?? {}) }, err.httpStatus);
  }
  throw err;
}

const isoDate = z.string().refine(isIsoDate, "must be a valid YYYY-MM-DD date");

const previewSchema = z.object({
  employee_id: z.string().optional(),
  leave_type_code: z.string().min(1),
  start_date: isoDate,
  end_date: isoDate,
  start_half_day: z.boolean().optional(),
  end_half_day: z.boolean().optional(),
  /** Preview only: whether the caller intends to attach a document. */
  has_attachment: z.boolean().optional(),
});

const submitSchema = previewSchema
  .omit({ has_attachment: true })
  .extend({
    reason: z.string().max(2000).optional(),
    attachment_file_id: z.string().optional(),
  });

const listQuerySchema = pageQuerySchema.extend({
  state: leaveRequestStateSchema.optional(),
  employee_id: z.string().optional(),
  /** `?scope=mine` (default) | `team` | `all`. */
  scope: z.enum(["mine", "team", "all"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const calendarQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  team_id: z.string().optional(),
  employee_id: z.string().optional(),
});

const cancelSchema = z.object({ comment: z.string().max(2000).optional() });

/** The calling user's id, or null for a tenant-API-key caller. */
function callerUserId(c: Context<AuthedEnv>): string | null {
  const actor = c.get("user");
  return actor?.type === "user" && actor.id ? actor.id : null;
}

/** A programmatic caller is `system` and bypasses the capability matrix. */
function isSystem(c: Context<AuthedEnv>): boolean {
  return c.get("user")?.type !== "user";
}

function hasPeopleRead(c: Context<AuthedEnv>): boolean {
  return isSystem(c) || can(c.get("user")?.role, "people:read");
}

function hasPeopleWrite(c: Context<AuthedEnv>): boolean {
  return isSystem(c) || can(c.get("user")?.role, "people:write");
}

function isAdmin(c: Context<AuthedEnv>): boolean {
  return isSystem(c) || c.get("user")?.role === "admin";
}

/**
 * The caller's own employee record.
 *
 * Null for a login with no employee record (an external admin) and for a
 * tenant-API-key caller, which has no "self" at all. Both are normal; the routes
 * that need a self turn it into a 400 naming the reason, matching `me.ts`.
 */
async function callerEmployee(c: Context<AuthedEnv>) {
  const userId = callerUserId(c);
  if (!userId) return null;
  return getEmployeeByUserId(c.env.DB, c.get("tenant").tenant_id, userId);
}

/**
 * Resolve which employee a request is *about*.
 *
 * Defaults to the caller. Naming somebody else needs `people:write` — that is
 * the HR-files-on-your-behalf case, and it is also the only way an
 * `employee`-role caller can be stopped from filing leave against a colleague's
 * balance.
 */
async function resolveSubjectEmployee(
  c: Context<AuthedEnv>,
  requested: string | undefined,
  action: "read" | "write",
): Promise<string | Response> {
  const self = await callerEmployee(c);

  if (!requested || requested === self?.employee_id) {
    if (self) return self.employee_id;
    // No self to fall back on. A programmatic caller must say who it means.
    return c.json(
      {
        error:
          "no employee record is linked to this login; name an employee_id explicitly " +
          "(requires people:write)",
        code: "not_linked",
      },
      400,
    );
  }

  const permitted = action === "write" ? hasPeopleWrite(c) : hasPeopleRead(c);
  if (!permitted) {
    return c.json(
      {
        error: `forbidden: acting on another employee's leave requires people:${action}`,
        code: "forbidden",
      },
      403,
    );
  }
  return requested;
}

/**
 * May this caller see this leave request?
 *
 * The approval check is the interesting one. It asks whether the caller holds
 * *any* approval row on this subject — not just a pending one — because a manager
 * must still be able to open the request they decided yesterday, and the
 * console's inbox lists decided items too. It is scoped to the single subject id,
 * so it grants nothing beyond the one row.
 */
async function mayReadRequest(
  c: Context<AuthedEnv>,
  request: { employee_id: string; employee_user_id: string | null; leave_request_id: string },
): Promise<boolean> {
  if (hasPeopleRead(c) || isAdmin(c)) return true;

  const userId = callerUserId(c);
  if (!userId) return false;
  if (request.employee_user_id === userId) return true;

  const approvals = await listApprovals(c.env.DB, c.get("tenant").tenant_id, {
    subject_type: "leave_request",
    subject_id: request.leave_request_id,
    approver_user_id: userId,
    limit: 1,
  });
  return approvals.length > 0;
}

/* ------------------------------------------------------------------ types */

/**
 * `GET /v1/leave/types` — the tenant's leave types.
 *
 * Readable by anyone who can log in: an employee cannot file leave without
 * knowing what kinds exist, and a leave type is not confidential.
 */
leave.get("/types", async (c) => {
  const types = await getLeaveTypes(c.env, c.get("tenant").tenant_id);
  return c.json({ items: types });
});

/* --------------------------------------------------------------- balances */

/**
 * `GET /v1/leave/balances?employee_id=&year=`
 *
 * Own balances by default; somebody else's needs `people:read`.
 */
leave.get("/balances", async (c) => {
  const rawYear = c.req.query("year");
  const year = rawYear ? Number.parseInt(rawYear, 10) : new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    return c.json({ error: "year must be a four-digit year", code: "invalid_request" }, 400);
  }

  const employeeId = await resolveSubjectEmployee(c, c.req.query("employee_id"), "read");
  if (typeof employeeId !== "string") return employeeId;

  try {
    const balances = await getBalances(c.env, c.get("tenant").tenant_id, employeeId, year);
    return c.json({ employee_id: employeeId, year, items: balances });
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireCapability } from "../middleware/capability";
import {
  createLeaveType,
  createPolicy,
  deleteTenantHoliday,
  effectiveHolidays,
  getLeaveSettings,
  getLeaveProfile,
  listAssignments,
  listLeaveTypes,
  listPolicies,
  listTenantHolidays,
  updateLeaveSettings,
  updateLeaveType,
  updatePolicy,
  upsertAssignment,
  upsertLeaveProfile,
  upsertTenantHoliday,
} from "../../modules/leave/service";
import { addAdjustment, closeLeaveYear, getBalances } from "../../modules/leave/balances";
import { countWorkingDays } from "../../modules/leave/workdays";
import { holidayList } from "../../modules/leave/holidays/resolve";
import { MY_STATES } from "../../modules/leave/holidays/states";
import { SHIPPED_YEARS } from "../../modules/leave/holidays/data";
import { statutoryBands, STATUTORY_BASES } from "../../modules/leave/statutory";
import { LeaveError } from "../../modules/leave/types";
import { yearOf } from "../../modules/leave/dates";

/**
 * Leave configuration and balances, mounted at /v1/people/leave.
 *
 * Gated on the `people` module by the mount table in `src/index.ts` — reads
 * need `people:read`, writes `people:write`. That is the correct bar: leave
 * policy is HR administration over the whole directory, and the self-service
 * `employee` tier reaches its *own* balance through /v1/me/leave instead,
 * exactly as it reads its own record through /v1/me/employee.
 *
 * Year-close is held to a higher bar again (`admin:write`) because it writes
 * irreversible carry-forward rows for every employee at once.
 *
 * **No route here can reject an entitlement for being below the Employment Act
 * minimum.** Policy writes return 200/201 with a `warnings` array alongside the
 * saved policy. See src/modules/leave/statutory.ts.
 */
export const leave = new Hono<AuthedEnv>();

const yearCloseGuard = requireCapability("admin:write");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO_DATE, "must be YYYY-MM-DD");
const yearSchema = z.coerce.number().int().min(2000).max(2100);

const workWeekSchema = z
  .array(z.number().min(0).max(1))
  .length(7, "work_week is 7 day fractions, index 0 = Sunday");

const employmentTypeSchema = z.enum(["full_time", "part_time", "contract", "intern"]);
const accrualMethodSchema = z.enum(["annual_upfront", "monthly_accrual", "on_anniversary"]);
const statutoryBasisSchema = z.enum([
  "annual",
  "sick",
  "hospitalisation",
  "maternity",
  "paternity",
]);

const createTypeSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_]+$/, "code must be lowercase letters, digits and underscores"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  is_paid: z.boolean().optional(),
  requires_attachment: z.boolean().optional(),
  max_consecutive_days: z.number().int().positive().nullish(),
  allows_half_day: z.boolean().optional(),
  carry_forward_allowed: z.boolean().optional(),
  allow_negative_balance: z.boolean().optional(),
  statutory_basis: statutoryBasisSchema.nullish(),
});

const patchTypeSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable(),
    is_paid: z.boolean(),
    requires_attachment: z.boolean(),
    max_consecutive_days: z.number().int().positive().nullable(),
    allows_half_day: z.boolean(),
    carry_forward_allowed: z.boolean(),
    allow_negative_balance: z.boolean(),
    statutory_basis: statutoryBasisSchema.nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

const bandSchema = z.object({
  employment_type: employmentTypeSchema.nullish(),
  min_months_service: z.number().int().min(0).optional(),
  max_months_service: z.number().int().positive().nullish(),
  entitlement_days: z.number().min(0).max(366),
});

const createPolicySchema = z.object({
  leave_type_id: z.string().min(1),
  name: z.string().min(1).max(200),
  accrual_method: accrualMethodSchema.optional(),
  carry_forward_max_days: z.number().min(0).max(366).optional(),
  carry_forward_expiry_months: z.number().int().min(1).max(12).nullish(),
  is_default: z.boolean().optional(),
  bands: z.array(bandSchema).min(1),
});

const patchPolicySchema = z
  .object({
    name: z.string().min(1).max(200),
    accrual_method: accrualMethodSchema,
    carry_forward_max_days: z.number().min(0).max(366),
    carry_forward_expiry_months: z.number().int().min(1).max(12).nullable(),
    is_default: z.boolean(),
    archived: z.boolean(),
    bands: z.array(bandSchema).min(1),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

const profileSchema = z
  .object({
    employee_id: z.string().min(1),
    work_state: z.string().length(3).nullable().optional(),
    work_week: workWeekSchema.nullable().optional(),
  })
  .refine((p) => p.work_state !== undefined || p.work_week !== undefined, {
    message: "nothing to set",
  });

const assignmentSchema = z.object({
  employee_id: z.string().min(1),
  leave_type_id: z.string().min(1),
  policy_id: z.string().min(1),
  entitlement_days_override: z.number().min(0).max(366).nullish(),
});

const holidaySchema = z.object({
  holiday_date: isoDate,
  name: z.string().min(1).max(200),
  // 'national' or a 3-letter state code; the service validates against the
  // registry so the error is a consistent LeaveError, not a Zod enum dump.
  scope: z.string().min(3).max(20),
  observed: z.boolean().optional(),
  note: z.string().max(500).nullish(),
});

// NOT z.coerce.boolean(): it treats any non-empty string as true, so
// `?start_half_day=false` would silently mean true. An explicit "true" test is
// the only reading that cannot surprise a caller.
const queryFlag = z
  .string()
  .optional()
  .transform((v) => v === "true");

const workingDaysQuerySchema = z.object({
  employee_id: z.string().min(1),
  start: isoDate,
  end: isoDate,
  start_half_day: queryFlag,
  end_half_day: queryFlag,
});

const balancesQuerySchema = z.object({
  employee_id: z.string().min(1),
  as_of: isoDate.optional(),
  leave_type_id: z.string().optional(),
});

const yearCloseSchema = z.object({
  leave_year: z.number().int().min(2000).max(2100),
  employee_id: z.string().optional(),
  dry_run: z.boolean().optional(),
});

const adjustmentSchema = z.object({
  employee_id: z.string().min(1),
  leave_type_id: z.string().min(1),
  leave_year: z.number().int().min(2000).max(2100),
  days: z.number().min(-366).max(366),
  kind: z.enum(["adjustment", "encashment"]).optional(),
  note: z.string().max(500).nullish(),
});

export function leaveErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof LeaveError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

// ---- Settings ----------------------------------------------------------

leave.get("/settings", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ settings: await getLeaveSettings(c.env.DB, tenant.tenant_id) });
});

leave.put("/settings", zValidator("json", z.object({ work_week: workWeekSchema })), async (c) => {
  const tenant = c.get("tenant");
  try {
    const settings = await updateLeaveSettings(c.env.DB, tenant.tenant_id, {
      work_week: c.req.valid("json").work_week as never,
    });
    return c.json({ settings });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

// ---- Leave types -------------------------------------------------------

leave.get("/types", async (c) => {
  const tenant = c.get("tenant");
  const includeArchived = c.req.query("include_archived") === "true";
  return c.json({
    leave_types: await listLeaveTypes(c.env.DB, tenant.tenant_id, {
      include_archived: includeArchived,
    }),
  });
});

leave.post("/types", zValidator("json", createTypeSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const leaveType = await createLeaveType(c.env.DB, tenant.tenant_id, c.req.valid("json"));
    return c.json({ leave_type: leaveType }, 201);
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.patch("/types/:id", zValidator("json", patchTypeSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const leaveType = await updateLeaveType(
      c.env.DB,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    return c.json({ leave_type: leaveType });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

/* ---------------------------------------------------------------- preview */

/**
 * `POST /v1/leave/preview`
 *
 * PRD-006 requires the computed working days be shown **before** submission, so
 * this is a first-class endpoint rather than something a client infers from a
 * failed submit. It writes nothing, and `submit` runs the identical computation —
 * so a console showing an empty `blockers` array is telling the truth about what
 * submit will do.
 *
 * A POST despite being a read, because the input is a structured body and putting
 * six fields on a query string to satisfy REST purity would make it worse to use.
 * `settings` does the same for its preview surfaces.
 */
leave.post("/preview", zValidator("json", previewSchema), async (c) => {
  const body = c.req.valid("json");
  const employeeId = await resolveSubjectEmployee(c, body.employee_id, "read");
  if (typeof employeeId !== "string") return employeeId;

  try {
    const preview = await previewLeaveRequest(c.env, c.get("tenant").tenant_id, {
      ...body,
      employee_id: employeeId,
    });
    return c.json(preview);
// ---- Policies ----------------------------------------------------------

leave.get("/policies", async (c) => {
  const tenant = c.get("tenant");
  return c.json({
    policies: await listPolicies(c.env.DB, tenant.tenant_id, {
      leave_type_id: c.req.query("leave_type_id"),
      include_archived: c.req.query("include_archived") === "true",
    }),
  });
});

leave.post("/policies", zValidator("json", createPolicySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const result = await createPolicy(c.env.DB, tenant.tenant_id, c.req.valid("json"));
    // 201 WITH warnings, never 422 because of them — a below-minimum
    // entitlement is the tenant's call to make.
    return c.json({ policy: result.policy, warnings: result.warnings }, 201);
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

/* --------------------------------------------------------------- requests */

/**
 * `GET /v1/leave/requests?scope=mine|team|all`
 *
 * `mine` is the default and is what an employee's own page uses. `team` is the
 * manager's view — direct reports plus teammates — and `all` needs `people:read`.
 */
leave.get("/requests", zValidator("query", listQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const tenantId = c.get("tenant").tenant_id;
  const scope = query.scope ?? (query.employee_id ? "all" : "mine");

  const filter: Parameters<typeof listLeaveRequests>[2] = {
    limit: query.limit,
    cursor: query.cursor,
    state: query.state,
    from: query.from,
    to: query.to,
  };

  if (scope === "all" || query.employee_id) {
    if (query.employee_id) {
      const employeeId = await resolveSubjectEmployee(c, query.employee_id, "read");
      if (typeof employeeId !== "string") return employeeId;
      filter.employee_id = employeeId;
    } else if (!hasPeopleRead(c)) {
      return c.json(
        { error: "forbidden: scope=all requires people:read", code: "forbidden" },
        403,
      );
    }
  } else if (scope === "mine") {
    const self = await callerEmployee(c);
    // A login with no employee record has no leave; an empty page is the honest
    // answer rather than a 400, because the console asks for this on page load.
    filter.employee_ids = self ? [self.employee_id] : [];
  } else {
    const self = await callerEmployee(c);
    filter.employee_ids = self ? await teamEmployeeIds(c, self) : [];
  }

  const rows = await listLeaveRequests(c.env.DB, tenantId, filter);
  return c.json(paginate(rows, query.limit, "leave_request_id"));
});

/**
 * The employee ids in one employee's team scope: their direct reports, their
 * teammates, and themselves.
 *
 * Same predicate as the team-overlap warning in the service — team **or**
 * manager — because `employees.team_id` is nullable and a tenant that never
 * created teams would otherwise get an empty calendar. Direct reports are
 * included so a manager sees the people whose leave they actually approve even
 * when nobody shares a team row.
 */
async function teamEmployeeIds(
  c: Context<AuthedEnv>,
  self: { employee_id: string; team_id: string | null },
): Promise<string[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT employee_id FROM employees
      WHERE tenant_id = ?
        AND (
          employee_id = ?
          OR manager_employee_id = ?
          OR (? IS NOT NULL AND team_id = ?)
        )`,
  )
    .bind(c.get("tenant").tenant_id, self.employee_id, self.employee_id, self.team_id, self.team_id)
    .all<{ employee_id: string }>();
  return (results ?? []).map((r) => r.employee_id);
}

/** `POST /v1/leave/requests` — file leave and route it for approval. */
leave.post("/requests", zValidator("json", submitSchema), async (c) => {
  const body = c.req.valid("json");
  const employeeId = await resolveSubjectEmployee(c, body.employee_id, "write");
  if (typeof employeeId !== "string") return employeeId;

  try {
    const request = await submitLeaveRequest(c.env, c.get("tenant").tenant_id, {
      ...body,
      employee_id: employeeId,
      reason: body.reason ?? null,
      attachment_file_id: body.attachment_file_id ?? null,
      requested_by: callerUserId(c),
    });
    return c.json(request, 201);
leave.patch("/policies/:id", zValidator("json", patchPolicySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const result = await updatePolicy(
      c.env.DB,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    return c.json({ policy: result.policy, warnings: result.warnings });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

/** The Employment Act tables the warnings are generated from, so the console
 * can show "statutory minimum: 12 days" next to the field. */
leave.get("/statutory-minimums", (c) =>
  c.json({
    statutory_minimums: STATUTORY_BASES.map((basis) => ({ basis, bands: statutoryBands(basis) })),
    note:
      "Employment Act 1955 as amended 2022. A seed default and a warning, not an enforced " +
      "floor — entitlements below these values save normally.",
  }),
);

// ---- Employee profiles and assignments ---------------------------------

leave.get("/employee-profiles", async (c) => {
  const employeeId = c.req.query("employee_id");
  if (!employeeId) return c.json({ error: "employee_id is required", code: "invalid_request" }, 400);
  const tenant = c.get("tenant");
  try {
    return c.json({ profile: await getLeaveProfile(c.env.DB, tenant.tenant_id, employeeId) });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.put("/employee-profiles", zValidator("json", profileSchema), async (c) => {
  const tenant = c.get("tenant");
  const { employee_id: employeeId, ...rest } = c.req.valid("json");
  try {
    const profile = await upsertLeaveProfile(c.env.DB, tenant.tenant_id, employeeId, rest as never);
    return c.json({ profile });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.get("/assignments", async (c) => {
  const employeeId = c.req.query("employee_id");
  if (!employeeId) return c.json({ error: "employee_id is required", code: "invalid_request" }, 400);
  const tenant = c.get("tenant");
  return c.json({ assignments: await listAssignments(c.env.DB, tenant.tenant_id, employeeId) });
});

leave.put("/assignments", zValidator("json", assignmentSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    return c.json({
      assignment: await upsertAssignment(c.env.DB, tenant.tenant_id, c.req.valid("json")),
    });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

/**
 * `GET /v1/leave/requests/:id`
 *
 * The route the approvals inbox card calls. Per-row authorization — see
 * `mayReadRequest`. A caller with no claim on the row gets 404 rather than 403.
 */
leave.get("/requests/:id", async (c) => {
  const tenantId = c.get("tenant").tenant_id;
  const request = await getLeaveRequest(c.env.DB, tenantId, c.req.param("id"));
  if (!request) return c.json({ error: "leave request not found" }, 404);
  if (!(await mayReadRequest(c, request))) {
    return c.json({ error: "leave request not found" }, 404);
  }

  // The context a decision needs, and only for somebody entitled to see the row.
  // Balance-after and team overlaps are PRD-006c's named card fields, and
  // recomputing them here rather than storing them means the manager sees the
  // position as it is now, not as it was when the request was filed.
  const preview = await previewLeaveRequest(c.env, tenantId, {
    employee_id: request.employee_id,
    leave_type_code: request.leave_type_code,
    start_date: request.start_date,
    end_date: request.end_date,
    start_half_day: request.start_half_day,
    end_half_day: request.end_half_day,
    has_attachment: Boolean(request.attachment_file_id),
    exclude_request_id: request.leave_request_id,
  }).catch(() => null);

  return c.json({
    ...request,
    balance: preview?.balance ?? null,
    // What the employee would have left if this were approved. Already excludes
    // the request itself, so it is the same number whether read before or after
    // the decision.
    balance_after_days: preview
      ? Math.round((preview.balance_after_days) * 100) / 100
      : null,
    team_overlaps: preview?.team_overlaps ?? [],
    excluded_days: preview?.excluded_days ?? [],
    approval: request.approval_id
      ? await getApproval(c.env.DB, tenantId, request.approval_id)
      : null,
  });
});

/**
 * `POST /v1/leave/requests/:id/cancel`
 *
 * Restricted to the employee it is about, or an admin. A `people:write` holder
 * is deliberately NOT enough on its own: HR can file leave for somebody, but
 * taking already-approved leave away is the "admin action" half of PRD-006's
 * sentence, and the service decides between outright cancellation and
 * re-approval from the actor's admin status.
 */
leave.post("/requests/:id/cancel", async (c) => {
  const tenantId = c.get("tenant").tenant_id;
  const requestId = c.req.param("id");

  const request = await getLeaveRequest(c.env.DB, tenantId, requestId);
  if (!request) return c.json({ error: "leave request not found" }, 404);

  let body: unknown = {};
  try {
    const raw = await c.req.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid JSON body", code: "invalid_request" }, 400);
  }
  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "invalid_request" }, 400);
  }

  const userId = callerUserId(c);
  const isOwn = request.employee_user_id !== null && request.employee_user_id === userId;
  if (!isOwn && !isAdmin(c)) {
    // Not a 404: the caller may legitimately be able to READ this row (a
    // manager holding its approval) and just not cancel it, so hiding the row
    // here would contradict the GET above.
    return c.json(
      {
        error: "only the employee the leave belongs to, or an administrator, may cancel it",
        code: "forbidden",
      },
      403,
    );
  }

  try {
    const result = await cancelLeaveRequest(c.env, tenantId, requestId, {
      actor_user_id: userId,
      actor_is_admin: isAdmin(c),
      comment: parsed.data.comment ?? null,
    });
    return c.json(result);
// ---- Public holidays ---------------------------------------------------

/** Malaysian states and the years the shipped calendar covers — what a console
 * state picker and year picker are built from. */
leave.get("/states", (c) =>
  c.json({ states: MY_STATES, shipped_holiday_years: SHIPPED_YEARS }),
);

leave.get("/holidays", async (c) => {
  const tenant = c.get("tenant");
  const parsedYear = yearSchema.safeParse(c.req.query("year") ?? new Date().getUTCFullYear());
  if (!parsedYear.success) {
    return c.json({ error: "year must be a four-digit year", code: "invalid_request" }, 400);
  }
  const year = parsedYear.data;
  const state = c.req.query("state") ?? null;

  const sets = await effectiveHolidays(c.env.DB, tenant.tenant_id, state, [year]);
  const set = sets.get(year)!;
  return c.json({
    year,
    state,
    holidays: holidayList(set),
    // Never let an unshipped year read as "no public holidays this year".
    holiday_data_available: set.dataAvailable,
    holiday_data_provisional: set.provisional,
    source_note: set.sourceNote,
    // The raw deltas too, so a console can show what this tenant changed.
    overrides: await listTenantHolidays(c.env.DB, tenant.tenant_id, year),
  });
});

leave.post("/holidays", zValidator("json", holidaySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const holiday = await upsertTenantHoliday(c.env.DB, tenant.tenant_id, c.req.valid("json"));
    return c.json({ holiday }, 201);
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.delete("/holidays/:id", async (c) => {
  const tenant = c.get("tenant");
  try {
    await deleteTenantHoliday(c.env.DB, tenant.tenant_id, c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

// ---- Working days and balances -----------------------------------------

leave.get("/working-days", zValidator("query", workingDaysQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const q = c.req.valid("query");
  try {
    return c.json(await workingDaysFor(c.env.DB, tenant.tenant_id, q));
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.get("/balances", zValidator("query", balancesQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const q = c.req.valid("query");
  try {
    return c.json(
      await getBalances(c.env.DB, tenant.tenant_id, q.employee_id, {
        as_of: q.as_of,
        leave_type_id: q.leave_type_id,
      }),
    );
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.post("/adjustments", zValidator("json", adjustmentSchema), async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  try {
    return c.json(
      await addAdjustment(c.env.DB, tenant.tenant_id, {
        ...c.req.valid("json"),
        created_by: actor?.type === "user" ? actor.id : null,
      }),
      201,
    );
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.post("/year-close", yearCloseGuard, zValidator("json", yearCloseSchema), async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  const input = c.req.valid("json");
  try {
    const results = await closeLeaveYear(c.env.DB, tenant.tenant_id, {
      ...input,
      created_by: actor?.type === "user" ? actor.id : null,
    });
    return c.json({ leave_year: input.leave_year, dry_run: input.dry_run === true, results });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

/* --------------------------------------------------------------- calendar */

/**
 * `GET /v1/leave/calendar?from=&to=&team_id=`
 *
 * The team calendar — "who is off, by team and by month". PRD-006 calls this the
 * feature managers actually use, and it is a read over `leave_requests` with no
 * new storage.
 *
 * Shows `approved` and `cancellation_pending` leave only. Pending requests are
 * deliberately excluded: the question this screen answers is "who will actually be
 * absent", and padding it with requests that may yet be refused would make it
 * useless for planning cover. `cancellation_pending` is included because the
 * leave is still booked until somebody agrees to give it back.
 *
 * Scope follows the list route: own team by default, another team or the whole
 * company needs `people:read`.
 */
leave.get("/calendar", zValidator("query", calendarQuerySchema), async (c) => {
  const query = c.req.valid("query");
  if (query.from > query.to) {
    return c.json({ error: "from must not be after to", code: "invalid_request" }, 400);
  }
  const tenantId = c.get("tenant").tenant_id;

  let employeeIds: string[] | undefined;
  if (query.team_id || query.employee_id) {
    if (!hasPeopleRead(c)) {
      return c.json(
        {
          error: "forbidden: filtering the calendar by team or employee requires people:read",
          code: "forbidden",
        },
        403,
      );
    }
    if (query.employee_id) {
      employeeIds = [query.employee_id];
    } else {
      const { results } = await c.env.DB.prepare(
        "SELECT employee_id FROM employees WHERE tenant_id = ? AND team_id = ?",
      )
        .bind(tenantId, query.team_id)
        .all<{ employee_id: string }>();
      employeeIds = (results ?? []).map((r) => r.employee_id);
    }
  } else if (!hasPeopleRead(c)) {
    const self = await callerEmployee(c);
    employeeIds = self ? await teamEmployeeIds(c, self) : [];
  }

  // Fetched unpaginated within the window on purpose: a calendar is only useful
  // whole, and a month of one company's leave is tens of rows. MAX_PAGE_LIMIT
  // caps it so an absurd range cannot be used to pull the entire table.
  const rows = await listLeaveRequests(c.env.DB, tenantId, {
    employee_ids: employeeIds,
    from: query.from,
    to: query.to,
    limit: 200,
  });

  return c.json({
    from: query.from,
    to: query.to,
    year: yearOf(query.from),
    items: rows.filter((r) => r.state === "approved" || r.state === "cancellation_pending"),
  });
});
/**
 * Shared by the HR and self-service working-day previews: resolve the
 * employee's work week and holiday set, then count. Exported so /v1/me/leave
 * gets exactly the same arithmetic rather than a second implementation that
 * can drift.
 */
export async function workingDaysFor(
  db: D1Database,
  tenantId: string,
  q: {
    employee_id: string;
    start: string;
    end: string;
    start_half_day?: boolean;
    end_half_day?: boolean;
  },
) {
  const [settings, profile] = await Promise.all([
    getLeaveSettings(db, tenantId),
    getLeaveProfile(db, tenantId, q.employee_id),
  ]);
  const years: number[] = [];
  for (let y = yearOf(q.start); y <= yearOf(q.end); y += 1) years.push(y);
  const byYear = await effectiveHolidays(db, tenantId, profile.work_state, years);

  const merged = {
    byDate: new Map(years.flatMap((y) => [...(byYear.get(y)?.byDate ?? new Map())])),
    dataAvailable: years.every((y) => byYear.get(y)?.dataAvailable ?? false),
    provisional: years.some((y) => byYear.get(y)?.provisional ?? false),
    sourceNote: null,
  };

  return {
    start: q.start,
    end: q.end,
    work_state: profile.work_state,
    work_week: profile.work_week ?? settings.work_week,
    ...countWorkingDays(q.start, q.end, profile.work_week ?? settings.work_week, merged, {
      start_half_day: q.start_half_day,
      end_half_day: q.end_half_day,
    }),
  };
}
