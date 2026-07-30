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
