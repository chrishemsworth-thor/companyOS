import { ulid } from "../../../lib/ulid";
import { makeEnvelope } from "../../../schemas/envelope";
import { cancelForSubject, requestApproval } from "../../approvals/service";
import type { Employee } from "../types";
import { spansOverlap, isIsoDate, workingDaysFor, yearOf } from "./calendar";
import { getEntitlement, getLeaveType, getLeaveTypes, getWorkCalendar } from "./policy-port";
import {
  BLOCKING_STATES,
  CONSUMING_STATES,
  type LeaveBalance,
  type LeaveBlocker,
  type LeavePreview,
  type LeaveRequest,
  type LeaveRequestState,
  type LeaveRequestView,
  type LeaveType,
  type LeaveWarning,
  type TeamOverlap,
} from "./types";

/**
 * Leave requests (PRD-006c).
 *
 * ## Balance is derived, never stored
 *
 * `available = entitlement + carry_forward − taken − pending`, computed on read
 * from `leave_requests`. Nothing decrements a counter, which makes three of
 * PRD-006's criteria fall out for free:
 *
 *  - *"a pending 3-day request reduces available balance by 3 immediately"* —
 *    `pending` is in `CONSUMING_STATES`.
 *  - *"a rejected request restores the balance"* — `rejected` is not, so it stops
 *    being subtracted the moment the state changes.
 *  - *"on approval the balance is decremented"* — it already was, at submission,
 *    and stays decremented as the days move from the pending bucket to the taken
 *    bucket.
 *
 * That last one is worth being explicit about, because it means **approval does
 * not mutate a balance**. There is no decrement to lose, so the pending→approved
 * transition needs no atomicity guarantee with the approval decision — which is
 * why this module transitions state from an event consumer (standing rule 2)
 * rather than reaching into the approvals primitive. S5's claims posting has the
 * opposite problem: a journal entry is a real side effect and PRD-006 demands it
 * be atomic with the decision.
 *
 * ## Approvals
 *
 * Every human decision goes through the S3 primitive. `requestApproval()` walks
 * up `manager_employee_id`, skips anyone without a live console login, skips the
 * requester, and terminates at a tenant admin (SESSION-PLAN C1) — this module
 * neither knows nor cares who ends up deciding, and never inserts into
 * `approvals`.
 */

/**
 * Mirrors ApprovalsError / FilesError / SupportError: a code, a message, and the
 * status the route returns. `illegal_transition` → 409 is the codebase's
 * state-machine convention (src/modules/support/state-machine.ts).
 */
export class LeaveError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_request"
      | "illegal_transition"
      | "forbidden"
      | "unprocessable",
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409 | 422,
    /** Structured detail for the blocking cases, so a console can act on it. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LeaveError";
  }
}

const COLUMNS =
  "leave_request_id, tenant_id, employee_id, leave_type_code, start_date, end_date, " +
  "start_half_day, end_half_day, working_days, reason, attachment_file_id, state, " +
  "approval_id, decided_at, cancelled_at, created_by, created_at, updated_at";

/** Legal moves, in one table, matching the ticket state machine's shape. */
const TRANSITIONS: Record<LeaveRequestState, readonly LeaveRequestState[]> = {
  pending: ["approved", "rejected", "cancelled"],
  // Approved leave can be handed back — either by an admin outright, or by the
  // employee raising a cancellation for re-approval.
  approved: ["cancellation_pending", "cancelled"],
  // The re-approval decision: agreed → cancelled, refused → back to approved.
  cancellation_pending: ["cancelled", "approved"],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: LeaveRequestState, to: LeaveRequestState): boolean {
  return TRANSITIONS[from].includes(to);
}

interface LeaveEnv {
  DB: D1Database;
  EVENTS: Queue;
}

/* ------------------------------------------------------------------ reads */

/** SQLite integers → booleans, plus the employee's name and login. */
function toView(row: LeaveRequest & { employee_name: string; employee_user_id: string | null }) {
  const { tenant_id: _tenant, ...rest } = row;
  return {
    ...rest,
    start_half_day: row.start_half_day !== 0,
    end_half_day: row.end_half_day !== 0,
  } as LeaveRequestView;
}

const VIEW_SELECT = `SELECT ${COLUMNS.split(", ")
  .map((c) => `r.${c}`)
  .join(", ")}, e.name AS employee_name, e.user_id AS employee_user_id
  FROM leave_requests r
  JOIN employees e ON e.tenant_id = r.tenant_id AND e.employee_id = r.employee_id`;

type ViewRow = LeaveRequest & { employee_name: string; employee_user_id: string | null };

/**
 * One request within a tenant. `tenant_id` is in the WHERE clause, so another
 * tenant's id simply does not resolve and the route turns that into a 404 rather
 * than a 403 — a 403 would confirm the id exists.
 */
export async function getLeaveRequest(
  db: D1Database,
  tenantId: string,
  leaveRequestId: string,
): Promise<LeaveRequestView | null> {
  const row = await db
    .prepare(`${VIEW_SELECT} WHERE r.tenant_id = ? AND r.leave_request_id = ?`)
    .bind(tenantId, leaveRequestId)
    .first<ViewRow>();
  return row ? toView(row) : null;
}

/** The raw row, for internal transitions that need `tenant_id` and no join. */
async function getRow(
  db: D1Database,
  tenantId: string,
  leaveRequestId: string,
): Promise<LeaveRequest | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM leave_requests WHERE tenant_id = ? AND leave_request_id = ?`)
    .bind(tenantId, leaveRequestId)
    .first<LeaveRequest>();
}

export interface ListLeaveFilter {
  employee_id?: string;
  /** Restrict to these employees — how the "my team" scope is expressed. */
  employee_ids?: string[];
  state?: LeaveRequestState;
  /** Only requests overlapping this window. */
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

/**
 * List requests, oldest first, cursor-paginated on the ULID primary key — the
 * same contract every other list endpoint in the codebase has.
 *
 * An `employee_ids` array of length zero means "no employees are in scope", not
 * "no filter": a manager with an empty team must see nothing rather than
 * everything. Expressed as an impossible predicate rather than an early return
 * so the pagination shape stays identical on that path.
 */
export async function listLeaveRequests(
  db: D1Database,
  tenantId: string,
  filter: ListLeaveFilter,
): Promise<LeaveRequestView[]> {
  const where = ["r.tenant_id = ?"];
  const binds: unknown[] = [tenantId];

  if (filter.employee_id) {
    where.push("r.employee_id = ?");
    binds.push(filter.employee_id);
  }
  if (filter.employee_ids) {
    if (filter.employee_ids.length === 0) {
      where.push("1 = 0");
    } else {
      where.push(`r.employee_id IN (${filter.employee_ids.map(() => "?").join(", ")})`);
      binds.push(...filter.employee_ids);
    }
  }
  if (filter.state) {
    where.push("r.state = ?");
    binds.push(filter.state);
  }
  // Overlap, not containment: a request that starts in June and ends in July
  // belongs on both months' calendars.
  if (filter.from) {
    where.push("r.end_date >= ?");
    binds.push(filter.from);
  }
  if (filter.to) {
    where.push("r.start_date <= ?");
    binds.push(filter.to);
  }
  if (filter.cursor) {
    where.push("r.leave_request_id > ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);

  const { results } = await db
    .prepare(
      `${VIEW_SELECT} WHERE ${where.join(" AND ")}
       ORDER BY r.leave_request_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<ViewRow>();
  return (results ?? []).map(toView);
}

/**
 * S6's `leave_types.leave_type_id` for a code, or null.
 *
 * The one place this module writes S6's key. It tolerates the table being
 * absent for the same reason policy-port.ts does — a deploy where 0025 has not
 * run yet is a real state, and leave must stay fileable through it — but unlike
 * the port it has no fallback to offer: there is no provisional id, so null is
 * the answer and S6's balance engine simply has nothing to group that row
 * under until the tenant configures its types.
 */
async function resolveLeaveTypeId(
  env: { DB: D1Database },
  tenantId: string,
  code: string,
): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT leave_type_id FROM leave_types WHERE tenant_id = ? AND code = ?",
    )
      .bind(tenantId, code)
      .first<{ leave_type_id: string }>();
    return row?.leave_type_id ?? null;
  } catch {
    return null;
  }
}

async function requireEmployee(
  db: D1Database,
  tenantId: string,
  employeeId: string,
): Promise<Employee> {
  const row = await db
    .prepare("SELECT * FROM employees WHERE tenant_id = ? AND employee_id = ?")
    .bind(tenantId, employeeId)
    .first<Employee>();
  if (!row) throw new LeaveError("not_found", "employee not found", 404);
  return row;
}

/* --------------------------------------------------------------- balances */

/**
 * Days already consumed, split into taken (`approved`) and pending
 * (`pending` + `cancellation_pending`), for one employee/type/year.
 *
 * Attributed by `start_date` year. A request spanning New Year is therefore
 * counted entirely against the year it starts in, which is wrong in the strict
 * sense and deliberately not fixed: splitting a span across two entitlement
 * years needs a per-day accrual model, which is S6's territory, and PRD-006 has
 * no criterion for it. Documented in docs/modules/leave.md as a known
 * simplification rather than left as a silent one.
 */
async function consumedDays(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  leaveTypeCode: string,
  year: number,
  excludeRequestId?: string,
): Promise<{ taken: number; pending: number }> {
  const consuming = CONSUMING_STATES.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'approved' THEN working_days ELSE 0 END), 0) AS taken,
         COALESCE(SUM(CASE WHEN state <> 'approved' THEN working_days ELSE 0 END), 0) AS pending
       FROM leave_requests
       WHERE tenant_id = ? AND employee_id = ? AND leave_type_code = ?
         AND state IN (${consuming})
         AND start_date >= ? AND start_date <= ?
         AND (? IS NULL OR leave_request_id <> ?)`,
    )
    .bind(
      tenantId,
      employeeId,
      leaveTypeCode,
      ...CONSUMING_STATES,
      `${year}-01-01`,
      `${year}-12-31`,
      excludeRequestId ?? null,
      excludeRequestId ?? null,
    )
    .first<{ taken: number; pending: number }>();
  return { taken: row?.taken ?? 0, pending: row?.pending ?? 0 };
}

/** The balance for one leave type. */
export async function getBalance(
  env: { DB: D1Database },
  tenantId: string,
  employee: Employee,
  leaveType: LeaveType,
  year: number,
): Promise<LeaveBalance> {
  const entitlement = await getEntitlement(env, tenantId, employee, leaveType.code, year);
  const { taken, pending } = await consumedDays(
    env.DB,
    tenantId,
    employee.employee_id,
    leaveType.code,
    year,
  );
  return {
    leave_type_code: leaveType.code,
    leave_type_name: leaveType.name,
    entitlement_days: entitlement.days,
    carry_forward_days: entitlement.carry_forward_days,
    taken_days: taken,
    pending_days: pending,
    available_days:
      entitlement.days + entitlement.carry_forward_days - taken - pending,
    entitlement_source: entitlement.source,
  };
}

/** Every leave type's balance for one employee. The `/v1/leave/balances` body. */
export async function getBalances(
  env: { DB: D1Database },
  tenantId: string,
  employeeId: string,
  year: number,
): Promise<LeaveBalance[]> {
  const employee = await requireEmployee(env.DB, tenantId, employeeId);
  const types = await getLeaveTypes(env, tenantId);
  const out: LeaveBalance[] = [];
  for (const type of types) {
    out.push(await getBalance(env, tenantId, employee, type, year));
  }
  return out;
}

/* ---------------------------------------------------------------- overlap */

/**
 * The same employee's own requests clashing with a proposed span.
 *
 * PRD-006 makes this a 409 rather than a warning, and it is the right call: two
 * live requests for one person over one day cannot both be honoured, so
 * accepting the second would create a balance the employee cannot actually
 * spend. Deliberately across ALL leave types — being on sick leave does not free
 * you up to also be on annual leave.
 */
async function findOwnOverlap(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  start: string,
  end: string,
  excludeRequestId?: string,
): Promise<LeaveRequest | null> {
  const blocking = BLOCKING_STATES.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM leave_requests
       WHERE tenant_id = ? AND employee_id = ?
         AND state IN (${blocking})
         AND start_date <= ? AND end_date >= ?
         AND (? IS NULL OR leave_request_id <> ?)
       ORDER BY start_date ASC LIMIT 1`,
    )
    .bind(
      tenantId,
      employeeId,
      ...BLOCKING_STATES,
      end,
      start,
      excludeRequestId ?? null,
      excludeRequestId ?? null,
    )
    .first<LeaveRequest>();
}

/**
 * Teammates whose approved leave clashes with a proposed span — the manager's
 * "will anyone be left covering this" question.
 *
 * A warning, never a block (PRD-006: "warn, do not block").
 *
 * Peers are the same team **or** the same manager. Team alone would be the
 * obvious predicate, but `employees.team_id` is nullable and plenty of small
 * tenants never create teams at all — the headline feature would then silently
 * do nothing for exactly the companies this PRD is aimed at. Same-manager
 * catches those, and the two together are still one query.
 */
export async function findTeamOverlaps(
  db: D1Database,
  tenantId: string,
  employee: Employee,
  start: string,
  end: string,
  excludeRequestId?: string,
): Promise<TeamOverlap[]> {
  const { results } = await db
    .prepare(
      `SELECT r.leave_request_id, r.employee_id, e.name AS employee_name, r.leave_type_code,
              r.start_date, r.end_date, r.working_days, r.state
       FROM leave_requests r
       JOIN employees e ON e.tenant_id = r.tenant_id AND e.employee_id = r.employee_id
       WHERE r.tenant_id = ?
         AND r.employee_id <> ?
         AND e.status = 'active'
         AND r.state = 'approved'
         AND r.start_date <= ? AND r.end_date >= ?
         AND (? IS NULL OR r.leave_request_id <> ?)
         AND (
           (? IS NOT NULL AND e.team_id = ?)
           OR (? IS NOT NULL AND e.manager_employee_id = ?)
         )
       ORDER BY r.start_date ASC`,
    )
    .bind(
      tenantId,
      employee.employee_id,
      end,
      start,
      excludeRequestId ?? null,
      excludeRequestId ?? null,
      employee.team_id,
      employee.team_id,
      employee.manager_employee_id,
      employee.manager_employee_id,
    )
    .all<TeamOverlap>();
  return results ?? [];
}

/* ---------------------------------------------------------------- preview */

export interface PreviewInput {
  employee_id: string;
  leave_type_code: string;
  start_date: string;
  end_date: string;
  start_half_day?: boolean;
  end_half_day?: boolean;
  /** Whether an attachment is present, for the requires-attachment blocker. */
  has_attachment?: boolean;
  /** Ignore this request when computing overlaps and balance (for re-preview). */
  exclude_request_id?: string;
}

/**
 * Everything the console needs before a submit, and everything submit checks.
 *
 * PRD-006 requires the computed working days be shown *before* submission, so
 * this is a real endpoint rather than a side effect of a failed submit. `submit`
 * calls the very same function and refuses when `blockers` is non-empty, so the
 * console can never show a green preview for a request the API will reject.
 */
export async function previewLeaveRequest(
  env: { DB: D1Database },
  tenantId: string,
  input: PreviewInput,
): Promise<LeavePreview> {
  if (!isIsoDate(input.start_date) || !isIsoDate(input.end_date)) {
    throw new LeaveError("invalid_request", "start_date and end_date must be YYYY-MM-DD", 400);
  }
  if (input.start_date > input.end_date) {
    throw new LeaveError("invalid_request", "start_date must not be after end_date", 400);
  }

  const employee = await requireEmployee(env.DB, tenantId, input.employee_id);
  const year = yearOf(input.start_date);
  const startHalf = input.start_half_day === true;
  const endHalf = input.end_half_day === true;

  const blockers: LeaveBlocker[] = [];
  const warnings: LeaveWarning[] = [];

  const leaveType = await getLeaveType(env, tenantId, input.leave_type_code);
  // An unknown type is fatal to everything downstream — there is no entitlement
  // to look up and no rules to apply — so this returns early rather than
  // accumulating blockers against a type that does not exist.
  if (!leaveType) {
    throw new LeaveError(
      "unprocessable",
      `unknown leave type '${input.leave_type_code}'`,
      422,
      { code: "unknown_leave_type" },
    );
  }

  const calendar = await getWorkCalendar(env, tenantId, employee, year);
  const counted = workingDaysFor(input.start_date, input.end_date, calendar, startHalf, endHalf);
  const balance = await getBalance(env, tenantId, employee, leaveType, year);

  // Re-previewing an existing request must not count that request against
  // itself, or an edit would look like it doubled the employee's usage.
  const selfConsumed = input.exclude_request_id
    ? await consumedDays(
        env.DB,
        tenantId,
        employee.employee_id,
        leaveType.code,
        year,
        input.exclude_request_id,
      )
    : null;
  const effectiveAvailable = selfConsumed
    ? balance.entitlement_days +
      balance.carry_forward_days -
      selfConsumed.taken -
      selfConsumed.pending
    : balance.available_days;

  if (counted.workingDays === 0) {
    blockers.push({
      code: "no_working_days",
      message:
        "the requested dates contain no working days — they fall entirely on non-working days or public holidays",
    });
  }

  if ((startHalf || endHalf) && !leaveType.allows_half_day) {
    blockers.push({
      code: "half_day_not_allowed",
      message: `${leaveType.name} cannot be taken as a half day`,
    });
  }

  if (
    leaveType.max_consecutive_days !== null &&
    counted.workingDays > leaveType.max_consecutive_days
  ) {
    blockers.push({
      code: "max_consecutive_days",
      message:
        `${leaveType.name} allows at most ${leaveType.max_consecutive_days} consecutive ` +
        `working days; this request is ${counted.workingDays}`,
    });
  }

  if (leaveType.requires_attachment && input.has_attachment !== true) {
    blockers.push({
      code: "attachment_required",
      message: `${leaveType.name} requires a supporting document`,
    });
  }

  // The stated exception: a type that allows a negative balance is never blocked
  // on one. Unpaid leave has no entitlement to run down.
  if (!leaveType.allows_negative_balance && counted.workingDays > effectiveAvailable) {
    const shortfall =
      Math.round((counted.workingDays - effectiveAvailable) * 100) / 100;
    blockers.push({
      code: "insufficient_balance",
      message:
        `this request is ${counted.workingDays} working days but only ${effectiveAvailable} ` +
        `days of ${leaveType.name} are available — short by ${shortfall}`,
      shortfall_days: shortfall,
      available_days: effectiveAvailable,
    });
  }

  const ownOverlap = await findOwnOverlap(
    env.DB,
    tenantId,
    employee.employee_id,
    input.start_date,
    input.end_date,
    input.exclude_request_id,
  );
  if (ownOverlap) {
    blockers.push({
      code: "overlapping_request",
      message:
        `these dates overlap an existing ${ownOverlap.state} request ` +
        `(${ownOverlap.start_date} to ${ownOverlap.end_date})`,
      conflicting_leave_request_id: ownOverlap.leave_request_id,
    });
  }

  const teamOverlaps = await findTeamOverlaps(
    env.DB,
    tenantId,
    employee,
    input.start_date,
    input.end_date,
    input.exclude_request_id,
  );
  if (teamOverlaps.length > 0) {
    warnings.push({
      code: "team_overlap",
      message:
        teamOverlaps.length === 1
          ? `${teamOverlaps[0]!.employee_name} is already on approved leave over these dates`
          : `${teamOverlaps.length} teammates are already on approved leave over these dates`,
    });
  }
  if (!leaveType.paid) {
    warnings.push({ code: "unpaid_leave", message: `${leaveType.name} is unpaid` });
  }
  // Surfaced rather than hidden: a balance computed from provisional defaults is
  // not policy, and a console that presents it as policy is how an employee
  // ends up trusting a number nobody configured.
  if (balance.entitlement_source === "default" || calendar.source === "default") {
    warnings.push({
      code: "policy_not_configured",
      message:
        "leave policy is not configured for this company — entitlement and the working-day " +
        "calendar are provisional defaults",
    });
  }

  return {
    leave_type_code: leaveType.code,
    start_date: input.start_date,
    end_date: input.end_date,
    start_half_day: startHalf,
    end_half_day: endHalf,
    working_days: counted.workingDays,
    calendar_days: counted.calendarDays,
    excluded_days: counted.excluded,
    balance,
    balance_after_days: Math.round((effectiveAvailable - counted.workingDays) * 100) / 100,
    team_overlaps: teamOverlaps,
    warnings,
    blockers,
    calendar_source: calendar.source,
  };
}

/* ----------------------------------------------------------------- submit */

export interface SubmitInput extends Omit<PreviewInput, "has_attachment"> {
  reason?: string | null;
  attachment_file_id?: string | null;
  /** The user filing it. Null for a programmatic caller. */
  requested_by?: string | null;
}

/**
 * File a leave request and route it for approval.
 *
 * Order matters: validate, then insert, then raise the approval, then emit. The
 * approval is raised AFTER the insert because `requestApproval` can legitimately
 * fail with 422 when a tenant has nobody able to decide — and a request row with
 * no approval is recoverable (an admin can be added and the request resubmitted),
 * whereas an approval pointing at a leave request that was never written is not.
 *
 * If the approval fails we delete the row we just wrote and rethrow, so the
 * failure is atomic from the caller's point of view. D1 has no multi-statement
 * transaction available here, and a compensating delete on a row nothing else can
 * have seen yet is the honest version of one.
 */
export async function submitLeaveRequest(
  env: LeaveEnv,
  tenantId: string,
  input: SubmitInput,
): Promise<LeaveRequestView> {
  const preview = await previewLeaveRequest(env, tenantId, {
    ...input,
    has_attachment: Boolean(input.attachment_file_id),
  });

  if (preview.blockers.length > 0) {
    const overlap = preview.blockers.find((b) => b.code === "overlapping_request");
    // The overlap blocker is a 409, not a 422: PRD-006 names that status
    // explicitly, and it is a state conflict with an existing row rather than a
    // problem with the request as submitted. Everything else is 422.
    const primary = overlap ?? preview.blockers[0]!;
    throw new LeaveError(
      overlap ? "illegal_transition" : "unprocessable",
      primary.message,
      overlap ? 409 : 422,
      { code: primary.code, blockers: preview.blockers },
    );
  }

  if (input.attachment_file_id) {
    // A request may only carry a file that exists, belongs to this tenant, and
    // was uploaded for this purpose — otherwise a caller could point a leave
    // request at somebody's expense receipt and have the approval card render
    // it.
    const file = await env.DB.prepare(
      `SELECT file_id FROM files
        WHERE tenant_id = ? AND file_id = ? AND purpose = 'leave_attachment'
          AND deleted_at IS NULL`,
    )
      .bind(tenantId, input.attachment_file_id)
      .first<{ file_id: string }>();
    if (!file) {
      throw new LeaveError(
        "invalid_request",
        "attachment_file_id does not name a leave_attachment file in this company",
        400,
      );
    }
  }

  const leaveRequestId = `lvr_${ulid()}`;
  // Store S6's `leave_type_id` alongside our own `leave_type_code`. This is the
  // join that makes the two halves of the module one module: S6's balance engine
  // (src/modules/leave/balances.ts) groups consumption by `leave_type_id`, so a
  // request written with only a code would be invisible to it and every
  // entitlement would read as fully available. Resolved here rather than by a
  // trigger or a view so the value is frozen at submission with everything else
  // on the row.
  //
  // NULL is the honest answer for a tenant that has configured no leave types
  // yet — the policy port is serving provisional defaults in that case and there
  // is no row to point at. See migrations/0026_leave_requests.sql.
  const leaveTypeId = await resolveLeaveTypeId(env, tenantId, input.leave_type_code);
  await env.DB.prepare(
    `INSERT INTO leave_requests
       (leave_request_id, tenant_id, employee_id, leave_type_code, leave_type_id,
        start_date, end_date,
        start_half_day, end_half_day, working_days, reason, attachment_file_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      leaveRequestId,
      tenantId,
      input.employee_id,
      input.leave_type_code,
      leaveTypeId,
      input.start_date,
      input.end_date,
      input.start_half_day === true ? 1 : 0,
      input.end_half_day === true ? 1 : 0,
      preview.working_days,
      input.reason ?? null,
      input.attachment_file_id ?? null,
      input.requested_by ?? null,
    )
    .run();

  let approvalId: string;
  try {
    const approval = await requestApproval(env, tenantId, {
      subject_type: "leave_request",
      subject_id: leaveRequestId,
      requested_by: input.requested_by ?? null,
      // So resolution walks up the SUBJECT's reporting line, not the filer's —
      // the case where HR files leave on somebody else's behalf.
      subject_employee_id: input.employee_id,
    });
    approvalId = approval.approval_id;
  } catch (err) {
    await env.DB.prepare(
      "DELETE FROM leave_requests WHERE tenant_id = ? AND leave_request_id = ?",
    )
      .bind(tenantId, leaveRequestId)
      .run();
    throw err;
  }

  await env.DB.prepare(
    "UPDATE leave_requests SET approval_id = ? WHERE tenant_id = ? AND leave_request_id = ?",
  )
    .bind(approvalId, tenantId, leaveRequestId)
    .run();

  const employee = await requireEmployee(env.DB, tenantId, input.employee_id);
  await env.EVENTS.send(
    makeEnvelope({
      event_type: "leave.requested",
      source_module: "people",
      tenant_id: tenantId,
      payload: {
        leave_request_id: leaveRequestId,
        employee_id: input.employee_id,
        employee_user_id: employee.user_id,
        leave_type_code: input.leave_type_code,
        start_date: input.start_date,
        end_date: input.end_date,
        working_days: preview.working_days,
        approval_id: approvalId,
        requested_by: input.requested_by ?? null,
      },
    }),
  );

  return (await getLeaveRequest(env.DB, tenantId, leaveRequestId))!;
}

/* ------------------------------------------------------------ transitions */

function assertTransition(row: LeaveRequest, to: LeaveRequestState): void {
  if (!canTransition(row.state, to)) {
    throw new LeaveError(
      "illegal_transition",
      `leave request is ${row.state} and cannot become ${to}`,
      409,
    );
  }
}

/**
 * Apply an approval decision. Called by the event consumer, never by a route.
 *
 * The same approval event means two different things depending on the state it
 * finds the request in, and that is the whole reason `cancellation_pending`
 * exists as a state rather than a column:
 *
 *  - `pending` + approved → the leave is granted.
 *  - `pending` + rejected → the leave is refused and the days come back.
 *  - `cancellation_pending` + approved → the cancellation is agreed; the leave is
 *    given back.
 *  - `cancellation_pending` + rejected → the cancellation is refused, so the
 *    leave stands and the request returns to `approved`.
 *
 * Idempotent: the UPDATE is guarded on the state it expects, so a redelivered
 * event changes nothing and returns null. Returns the resulting state, or null
 * when there was nothing to do — the consumer needs that to decide whether to
 * emit.
 */
export async function applyApprovalDecision(
  db: D1Database,
  tenantId: string,
  leaveRequestId: string,
  decision: "approved" | "rejected",
  decidedAt: string,
): Promise<{ from: LeaveRequestState; to: LeaveRequestState } | null> {
  const row = await getRow(db, tenantId, leaveRequestId);
  if (!row) return null;

  let to: LeaveRequestState;
  if (row.state === "pending") {
    to = decision === "approved" ? "approved" : "rejected";
  } else if (row.state === "cancellation_pending") {
    to = decision === "approved" ? "cancelled" : "approved";
  } else {
    // Already terminal, or a redelivered event. Not an error.
    return null;
  }

  const result = await db
    .prepare(
      `UPDATE leave_requests
          SET state = ?, decided_at = ?,
              cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
              updated_at = ?
        WHERE tenant_id = ? AND leave_request_id = ? AND state = ?`,
    )
    .bind(to, decidedAt, to, decidedAt, decidedAt, tenantId, leaveRequestId, row.state)
    .run();

  // Lost the race to a concurrent delivery of the same event. The other one did
  // the work and emitted; this one must not emit a second time.
  if ((result.meta.changes ?? 0) === 0) return null;
  return { from: row.state, to };
}

export interface CancelInput {
  /** The user cancelling. Null for a programmatic caller. */
  actor_user_id: string | null;
  /** True when the actor holds `admin` — the outright-cancel override. */
  actor_is_admin: boolean;
  comment?: string | null;
}

export interface CancelResult {
  request: LeaveRequestView;
  /** `cancelled` outright, or `cancellation_pending` awaiting re-approval. */
  outcome: "cancelled" | "cancellation_pending";
}

/**
 * Withdraw a leave request.
 *
 * PRD-006: *"Employee may cancel while pending; cancelling an approved future
 * leave requires re-approval or admin action."* Three paths, one function:
 *
 *  1. **Pending** → cancelled outright, and the pending approval is cancelled
 *     through the primitive. That is PRD-000's *"given a cancelled subject, then
 *     the approval is `cancelled` and no longer appears in pending lists"* — the
 *     state change alone satisfies it, which is why `cancelForSubject` emits no
 *     event of its own.
 *  2. **Approved, and the actor is an admin** → cancelled outright. The "admin
 *     action" half of the sentence.
 *  3. **Approved, anyone else** → `cancellation_pending` plus a NEW approval.
 *     The employee does not get to un-take approved leave unilaterally; their
 *     manager has to agree to give it back.
 *
 * Approved leave that has already started is a 409 in every case. Handing back
 * days somebody has already been absent for would need a balance adjustment
 * nobody has specified, and silently allowing it would be the kind of wrong
 * balance PRD-006 says destroys trust permanently.
 */
export async function cancelLeaveRequest(
  env: LeaveEnv,
  tenantId: string,
  leaveRequestId: string,
  input: CancelInput,
): Promise<CancelResult> {
  const row = await getRow(env.DB, tenantId, leaveRequestId);
  if (!row) throw new LeaveError("not_found", "leave request not found", 404);

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  if (row.state === "pending") {
    assertTransition(row, "cancelled");
    await env.DB.prepare(
      `UPDATE leave_requests SET state = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE tenant_id = ? AND leave_request_id = ? AND state = 'pending'`,
    )
      .bind(now, now, tenantId, leaveRequestId)
      .run();
    // Through the primitive, so the approver's queue drains. Not a decision —
    // nobody decided anything — so no approval.* event is emitted.
    await cancelForSubject(env, tenantId, "leave_request", leaveRequestId);
    await emitCancelled(env, tenantId, row, "pending", input.actor_user_id);
    return { request: (await getLeaveRequest(env.DB, tenantId, leaveRequestId))!, outcome: "cancelled" };
  }

  if (row.state === "approved") {
    if (row.start_date <= today) {
      throw new LeaveError(
        "illegal_transition",
        "approved leave that has already started cannot be cancelled — ask an administrator to adjust it",
        409,
      );
    }

    if (input.actor_is_admin) {
      assertTransition(row, "cancelled");
      await env.DB.prepare(
        `UPDATE leave_requests SET state = 'cancelled', cancelled_at = ?, updated_at = ?
          WHERE tenant_id = ? AND leave_request_id = ? AND state = 'approved'`,
      )
        .bind(now, now, tenantId, leaveRequestId)
        .run();
      await emitCancelled(env, tenantId, row, "approved", input.actor_user_id);
      return {
        request: (await getLeaveRequest(env.DB, tenantId, leaveRequestId))!,
        outcome: "cancelled",
      };
    }

    assertTransition(row, "cancellation_pending");
    // Raise the second approval BEFORE moving state, so a tenant with nobody
    // able to decide leaves the request approved rather than stranding it in
    // `cancellation_pending` with no approval to resolve it.
    const approval = await requestApproval(env, tenantId, {
      subject_type: "leave_request",
      subject_id: leaveRequestId,
      requested_by: input.actor_user_id,
      subject_employee_id: row.employee_id,
    });
    const moved = await env.DB.prepare(
      `UPDATE leave_requests
          SET state = 'cancellation_pending', approval_id = ?, updated_at = ?
        WHERE tenant_id = ? AND leave_request_id = ? AND state = 'approved'`,
    )
      .bind(approval.approval_id, now, tenantId, leaveRequestId)
      .run();

    // Lost the race — something else moved the request out of `approved` between
    // the read and here. The approval we just raised now describes nothing, and
    // leaving it would park an unanswerable request in the approver's queue
    // permanently: exactly the "pending forever with no error" failure PRD-000
    // exists to prevent. So take it back out.
    if ((moved.meta.changes ?? 0) === 0) {
      await cancelForSubject(env, tenantId, "leave_request", leaveRequestId);
      throw new LeaveError(
        "illegal_transition",
        "this leave request changed while the cancellation was being raised — reload and try again",
        409,
      );
    }

    return {
      request: (await getLeaveRequest(env.DB, tenantId, leaveRequestId))!,
      outcome: "cancellation_pending",
    };
  }

  assertTransition(row, "cancelled");
  // Unreachable — assertTransition throws for every remaining state — but left
  // as the explicit fall-through rather than a cast, so adding a state to the
  // machine surfaces here instead of silently doing nothing.
  throw new LeaveError("illegal_transition", `leave request is ${row.state}`, 409);
}

/**
 * `leave.cancelled.v1`.
 *
 * Emitted for the two paths where a human's leave disappears without an approval
 * decision behind it: the employee withdrawing a pending request, and an admin
 * cancelling approved leave. The third path — a cancellation that went through
 * re-approval — is emitted by the consumer instead, because there the decision
 * IS the cancellation.
 */
async function emitCancelled(
  env: LeaveEnv,
  tenantId: string,
  row: LeaveRequest,
  previousState: LeaveRequestState,
  cancelledBy: string | null,
): Promise<void> {
  const employee = await requireEmployee(env.DB, tenantId, row.employee_id);
  await env.EVENTS.send(
    makeEnvelope({
      event_type: "leave.cancelled",
      source_module: "people",
      tenant_id: tenantId,
      payload: {
        leave_request_id: row.leave_request_id,
        employee_id: row.employee_id,
        employee_user_id: employee.user_id,
        leave_type_code: row.leave_type_code,
        start_date: row.start_date,
        end_date: row.end_date,
        working_days: row.working_days,
        previous_state: previousState,
        cancelled_by: cancelledBy,
      },
    }),
  );
}

/**
 * Emit the decision event for a leave request whose approval was just decided.
 * Called by the consumer, which owns the state transition.
 */
export async function emitDecision(
  env: LeaveEnv,
  tenantId: string,
  leaveRequestId: string,
  transition: { from: LeaveRequestState; to: LeaveRequestState },
  decidedBy: string | null,
  decidedAt: string,
  comment: string | null,
): Promise<void> {
  const row = await getRow(env.DB, tenantId, leaveRequestId);
  if (!row) return;
  const employee = await requireEmployee(env.DB, tenantId, row.employee_id);

  const base = {
    leave_request_id: row.leave_request_id,
    employee_id: row.employee_id,
    employee_user_id: employee.user_id,
    leave_type_code: row.leave_type_code,
    start_date: row.start_date,
    end_date: row.end_date,
    working_days: row.working_days,
  };

  // A `cancellation_pending → cancelled` transition is a cancellation, not an
  // approval, even though an approve decision drove it. The event has to
  // describe what happened to the LEAVE, not which button was pressed.
  if (transition.to === "cancelled") {
    await env.EVENTS.send(
      makeEnvelope({
        event_type: "leave.cancelled",
        source_module: "people",
        tenant_id: tenantId,
        payload: { ...base, previous_state: transition.from, cancelled_by: decidedBy },
      }),
    );
    return;
  }

  if (transition.to === "rejected") {
    await env.EVENTS.send(
      makeEnvelope({
        event_type: "leave.rejected",
        source_module: "people",
        tenant_id: tenantId,
        payload: { ...base, rejected_by: decidedBy, decided_at: decidedAt, comment },
      }),
    );
    return;
  }

  // `pending → approved` (granted) and `cancellation_pending → approved` (the
  // cancellation was refused, so the leave stands). Both leave the employee with
  // approved leave, which is what the event says.
  await env.EVENTS.send(
    makeEnvelope({
      event_type: "leave.approved",
      source_module: "people",
      tenant_id: tenantId,
      payload: { ...base, approved_by: decidedBy, decided_at: decidedAt },
    }),
  );
}
