import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { resolveApprover } from "./resolution";
import {
  subjectTypeSchema,
  type Approval,
  type ApprovalState,
  type Decision,
  type RequestApprovalInput,
} from "./types";

/**
 * Approvals primitive (PRD-000b).
 *
 * The internal API is the real API: modules call `requestApproval` / `cancel`
 * directly and never insert into `approvals` themselves. The HTTP surface
 * (src/gateway/routes/approvals.ts) exists only so a human can see and act on
 * their queue; it is a thin shell over `decide` and `listApprovals`.
 *
 * Two rules carry the whole primitive:
 *
 *  - **An approval always names somebody who can act.** Resolution runs before
 *    the insert and fails loudly if nobody in the tenant qualifies, so no row
 *    is ever parked on a user who cannot log in (SESSION-PLAN C1).
 *  - **Decisions are terminal.** A decided approval cannot be re-decided,
 *    re-approved, or cancelled. The audit record PRD-000's auditor story asks
 *    for is only defensible if it is immutable.
 *
 * A rejected request is not reopened here: resubmission creates a NEW approval
 * and the rejected row stands (SESSION-PLAN C8).
 */

/**
 * Mirrors SupportError and FilesError: a code, a message, and the status the
 * route returns. `illegal_transition` → 409 is the codebase's state-machine
 * convention (src/modules/support/state-machine.ts), which PRD-000 explicitly
 * asks approvals to match.
 */
export class ApprovalsError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_request"
      | "illegal_transition"
      | "forbidden"
      | "no_approver",
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409 | 422,
  ) {
    super(message);
    this.name = "ApprovalsError";
  }
}

const APPROVAL_COLUMNS =
  "approval_id, tenant_id, subject_type, subject_id, requested_by, approver_user_id, state, " +
  "decision_comment, decided_by, decided_at, created_at, idempotency_key";

/**
 * Legal moves, in one explicit table so they are auditable at a glance — the
 * same shape as the ticket state machine. Everything out of `pending` is
 * terminal.
 */
const TRANSITIONS: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ["approved", "rejected", "cancelled"],
  approved: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: ApprovalState, to: ApprovalState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Environment a service call needs: D1 plus the event bus. */
interface ApprovalsEnv {
  DB: D1Database;
  EVENTS: Queue;
}

/**
 * Resolve one approval within a tenant. `tenant_id` is in the WHERE clause, so
 * another tenant's approval id simply does not resolve and the route turns that
 * into a 404 rather than a 403 — a 403 would confirm the id exists.
 */
export async function getApproval(
  db: D1Database,
  tenantId: string,
  approvalId: string,
): Promise<Approval | null> {
  return db
    .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE tenant_id = ? AND approval_id = ?`)
    .bind(tenantId, approvalId)
    .first<Approval>();
}

/** The live approval for a subject, if any. How a module finds its own row. */
export async function getApprovalForSubject(
  db: D1Database,
  tenantId: string,
  subjectType: string,
  subjectId: string,
  state: ApprovalState = "pending",
): Promise<Approval | null> {
  return db
    .prepare(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals
       WHERE tenant_id = ? AND subject_type = ? AND subject_id = ? AND state = ?
       ORDER BY approval_id DESC LIMIT 1`,
    )
    .bind(tenantId, subjectType, subjectId, state)
    .first<Approval>();
}

export interface ListApprovalsFilter {
  state?: ApprovalState;
  subject_type?: string;
  subject_id?: string;
  /** Restrict to approvals this user owes a decision on. */
  approver_user_id?: string;
  /** Restrict to approvals this user raised. */
  requested_by?: string;
  limit: number;
  cursor?: string;
}

/**
 * List approvals for a tenant, oldest first.
 *
 * Oldest-first is deliberate and is what PRD-007's inbox wants: the thing that
 * has been waiting longest is the thing most likely to be blocking somebody.
 * `approval_id` is a ULID, so ordering by it IS chronological order and the
 * cursor pagination helper works on it unchanged.
 *
 * Fetches `limit + 1` rows so the caller can detect another page without a
 * COUNT.
 */
export async function listApprovals(
  db: D1Database,
  tenantId: string,
  filter: ListApprovalsFilter,
): Promise<Approval[]> {
  const where = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (filter.state) {
    where.push("state = ?");
    binds.push(filter.state);
  }
  if (filter.subject_type) {
    where.push("subject_type = ?");
    binds.push(filter.subject_type);
  }
  if (filter.subject_id) {
    where.push("subject_id = ?");
    binds.push(filter.subject_id);
  }
  if (filter.approver_user_id) {
    where.push("approver_user_id = ?");
    binds.push(filter.approver_user_id);
  }
  if (filter.requested_by) {
    where.push("requested_by = ?");
    binds.push(filter.requested_by);
  }
  if (filter.cursor) {
    where.push("approval_id > ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);

  const { results } = await db
    .prepare(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals
       WHERE ${where.join(" AND ")}
       ORDER BY approval_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<Approval>();
  return results ?? [];
}

/**
 * Raise an approval request.
 *
 * The internal entry point every consuming module calls. Resolves the approver
 * first (so a row can never name somebody unable to act), inserts, then emits
 * `approval.requested` — which is what S4's notification consumer turns into
 * the approver's unread badge.
 *
 * Idempotent when given a key: a repeat call returns the existing row rather
 * than raising a second request for the same subject.
 */
export async function requestApproval(
  env: ApprovalsEnv,
  tenantId: string,
  input: RequestApprovalInput,
): Promise<Approval> {
  const parsed = subjectTypeSchema.safeParse(input.subject_type);
  if (!parsed.success) {
    throw new ApprovalsError(
      "invalid_request",
      `unknown subject_type '${input.subject_type}': expected one of ${subjectTypeSchema.options.join(", ")}`,
      400,
    );
  }
  const subjectType = parsed.data;
  if (!input.subject_id) {
    throw new ApprovalsError("invalid_request", "subject_id is required", 400);
  }

  const requestedBy = input.requested_by ?? null;

  // Replay before doing any work, so a retry is cheap and cannot double-emit.
  if (input.idempotency_key) {
    const existing = await env.DB.prepare(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE tenant_id = ? AND idempotency_key = ?`,
    )
      .bind(tenantId, input.idempotency_key)
      .first<Approval>();
    if (existing) return existing;
  }

  let approverUserId = input.approver_user_id ?? null;
  let strategy = "explicit";
  let hops = 0;
  if (!approverUserId) {
    const resolved = await resolveApprover(env.DB, tenantId, {
      subjectType,
      requesterUserId: requestedBy,
      subjectEmployeeId: input.subject_employee_id ?? null,
    });
    if (!resolved) {
      // 422, not 500: the request is well-formed, the tenant just has nobody
      // who can act on it. Deliberately thrown BEFORE the insert, so a
      // tenant in this state has no unactionable rows to clean up later.
      throw new ApprovalsError(
        "no_approver",
        `no eligible approver for subject_type '${subjectType}': no one in the reporting chain has a console login and the tenant has no active admin`,
        422,
      );
    }
    approverUserId = resolved.approver_user_id;
    strategy = resolved.strategy;
    hops = resolved.hops;
  }

  const approvalId = `apr_${ulid()}`;
  await env.DB.prepare(
    `INSERT INTO approvals
       (approval_id, tenant_id, subject_type, subject_id, requested_by, approver_user_id, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      approvalId,
      tenantId,
      subjectType,
      input.subject_id,
      requestedBy,
      approverUserId,
      input.idempotency_key ?? null,
    )
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "approval.requested",
      source_module: "platform",
      tenant_id: tenantId,
      payload: {
        approval_id: approvalId,
        subject_type: subjectType,
        subject_id: input.subject_id,
        requested_by: requestedBy,
        approver_user_id: approverUserId,
        resolution_strategy: strategy,
        resolution_hops: hops,
      },
    }),
  );

  return (await getApproval(env.DB, tenantId, approvalId))!;
}

/**
 * Guard a transition out of the row's current state.
 *
 * The 409 message names the current state, matching the Support convention and
 * PRD-000's "return 409 listing the current state".
 */
function assertTransition(approval: Approval, to: ApprovalState): void {
  if (!canTransition(approval.state, to)) {
    throw new ApprovalsError(
      "illegal_transition",
      `approval is ${approval.state} and cannot be ${to}: decisions are terminal`,
      409,
    );
  }
}

export interface DecideInput {
  /** The user recording the decision. */
  actor_user_id: string;
  /** The actor's role, for the admin override on both authorization rules. */
  actor_role?: string;
  decision: Decision;
  /**
   * Optional, per PRD-000 ("approve or reject with an optional comment"). The
   * console requires one on reject (PRD-007); the primitive does not, so a
   * module calling `decide` programmatically is not blocked by a UI rule.
   */
  comment?: string | null;
}

/**
 * Record a terminal decision.
 *
 * Three gates, in order:
 *
 *  1. **Existence** — scoped by tenant, so another tenant's id is a 404.
 *  2. **Authorization** — the assigned approver, or an admin. Anyone else 403s.
 *  3. **Self-approval** — blocked unless the decider holds `admin`. Resolution
 *     already avoids assigning a request to its own requester, so this is a
 *     second belt: it covers an explicitly-passed approver and the solo-admin
 *     tenant, where resolution legitimately routes an admin's request back to
 *     them.
 *
 * Then the state guard, so a decided approval 409s rather than being overwritten.
 */
export async function decide(
  env: ApprovalsEnv,
  tenantId: string,
  approvalId: string,
  input: DecideInput,
): Promise<Approval> {
  const approval = await getApproval(env.DB, tenantId, approvalId);
  if (!approval) throw new ApprovalsError("not_found", "approval not found", 404);

  const isAdmin = input.actor_role === "admin";
  const isApprover = approval.approver_user_id === input.actor_user_id;
  if (!isApprover && !isAdmin) {
    throw new ApprovalsError(
      "forbidden",
      "only the assigned approver or an admin may decide this approval",
      403,
    );
  }
  if (approval.requested_by && approval.requested_by === input.actor_user_id && !isAdmin) {
    throw new ApprovalsError(
      "forbidden",
      "you cannot decide your own request unless you hold the admin role",
      403,
    );
  }

  // State last, so an unauthorized caller learns nothing about the row's state.
  assertTransition(approval, input.decision);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE approvals
       SET state = ?, decision_comment = ?, decided_by = ?, decided_at = ?
     WHERE tenant_id = ? AND approval_id = ? AND state = 'pending'`,
  )
    .bind(input.decision, input.comment ?? null, input.actor_user_id, now, tenantId, approvalId)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: input.decision === "approved" ? "approval.approved" : "approval.rejected",
      source_module: "platform",
      tenant_id: tenantId,
      payload: {
        approval_id: approvalId,
        subject_type: approval.subject_type,
        subject_id: approval.subject_id,
        // Both parties travel on every payload: S4's consumer notifies the
        // requester on a decision and the approver on a request, and must not
        // need a database lookup to know who they are.
        requested_by: approval.requested_by,
        approver_user_id: approval.approver_user_id,
        decided_by: input.actor_user_id,
        decided_at: now,
        ...(input.comment ? { comment: input.comment } : {}),
      },
    }),
  );

  return (await getApproval(env.DB, tenantId, approvalId))!;
}

/**
 * Cancel a pending approval because its subject went away — a withdrawn leave
 * request, a deleted claim.
 *
 * Not a decision: no event is emitted and `decided_by`/`decided_at` stay NULL,
 * because nobody decided anything. The subject module emits its own
 * `*.cancelled` event; a second `approval.cancelled` would have the
 * notification consumer telling an approver about work that has simply
 * evaporated. PRD-000's criterion is only that the approval is `cancelled` and
 * stops appearing in pending lists, which the state change alone satisfies.
 *
 * Cancelling a decided approval is a 409: it has already been acted on.
 */
export async function cancel(
  env: ApprovalsEnv,
  tenantId: string,
  approvalId: string,
): Promise<Approval> {
  const approval = await getApproval(env.DB, tenantId, approvalId);
  if (!approval) throw new ApprovalsError("not_found", "approval not found", 404);
  assertTransition(approval, "cancelled");

  await env.DB.prepare(
    `UPDATE approvals SET state = 'cancelled'
     WHERE tenant_id = ? AND approval_id = ? AND state = 'pending'`,
  )
    .bind(tenantId, approvalId)
    .run();

  return (await getApproval(env.DB, tenantId, approvalId))!;
}

/** Cancel whatever pending approval a subject has, if it has one. */
export async function cancelForSubject(
  env: ApprovalsEnv,
  tenantId: string,
  subjectType: string,
  subjectId: string,
): Promise<Approval | null> {
  const pending = await getApprovalForSubject(env.DB, tenantId, subjectType, subjectId);
  if (!pending) return null;
  return cancel(env, tenantId, pending.approval_id);
}
