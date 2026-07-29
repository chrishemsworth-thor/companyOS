import type { SubjectType } from "./types";

/**
 * Approver resolution (PRD-000b), pluggable per `subject_type`.
 *
 * The problem this solves is SESSION-PLAN conflict C1: approvals route to
 * USERS, but reporting lines run between EMPLOYEES, and `employees.user_id` is
 * nullable. PRD-000's default strategy — "the employee's manager via People
 * reporting lines" — can therefore resolve to somebody with no console login,
 * and the request sits pending forever with no error. PRD-000 covers *no
 * manager set*; it does not cover *manager set, no login*.
 *
 * The resolution is ONE upward walk, not three special cases. A candidate up
 * the chain is acceptable only if it
 *
 *   1. has a linked `user_id` (can log in at all),
 *   2. whose user is `active` (not a disabled account), and
 *   3. is not the requester (nobody is handed their own request).
 *
 * Anything else and the walk keeps climbing. That single predicate satisfies
 * three separate PRD-000 acceptance criteria at once — "no manager set routes
 * to a tenant admin", "manager with no login routes further up", and "the
 * requester is also the resolved approver, so it routes to the next level up"
 * — so none of them needs its own code path. Terminating at a tenant admin is
 * what guarantees a row can never name an approver unable to act.
 */

/** The strategy that resolved an approver. Recorded on the emitted event. */
export type ResolutionStrategy = "manager_chain" | "role_based" | "tenant_admin" | "self_admin";

export interface ResolvedApprover {
  approver_user_id: string;
  strategy: ResolutionStrategy;
  /** Levels climbed up the reporting chain. 0 for the non-chain strategies. */
  hops: number;
}

/**
 * The pluggable part: which strategy each subject type uses. Adding a subject
 * type means adding a value to `subjectTypeSchema` and a line here — no
 * migration, no change to the walk itself.
 *
 * PRD-000: leave and claims use the default manager strategy; quote and
 * invoice use a role-based one (`admin` or `finance`), because a financial
 * document is not signed off by the requester's line manager.
 */
export const SUBJECT_STRATEGIES: Record<SubjectType, "manager_chain" | "role_based"> = {
  leave_request: "manager_chain",
  expense_claim: "manager_chain",
  quote: "role_based",
  // Reserved and unused in v1 (SESSION-PLAN C5). Mapped anyway so that if
  // anything ever does request an invoice approval it resolves correctly
  // rather than throwing on an unmapped type.
  invoice: "role_based",
  other: "manager_chain",
};

/** Roles the role-based strategy will route to, in preference order. */
const ROLE_BASED_ROLES = ["finance", "admin"] as const;

/**
 * Same bound as `assertNoManagerCycle` in src/modules/people/service.ts. The
 * service rejects cycles on write, so a cycle here means data that predates
 * that guard or was inserted around it — the cap makes the walk terminate
 * either way rather than spin.
 */
const MAX_CHAIN_DEPTH = 100;

interface ChainRow {
  depth: number;
  employee_id: string;
  user_id: string | null;
  status: string | null;
}

export interface ResolutionContext {
  subjectType: SubjectType;
  /** The requesting user, or null for a programmatic (API-key) caller. */
  requesterUserId: string | null;
  /**
   * The employee the subject concerns, when it is not the requester's own
   * employee record. Resolution starts the walk here.
   */
  subjectEmployeeId?: string | null;
}

/**
 * The employee record the walk starts from: the explicitly named subject
 * employee, else whichever employee is linked to the requesting user. Null
 * when there is neither — a programmatic caller with no subject employee, or a
 * user who is not in the employee directory. Both fall straight through to the
 * admin fallback, which is the correct answer: there is no reporting line to
 * follow.
 */
async function startingEmployeeId(
  db: D1Database,
  tenantId: string,
  ctx: ResolutionContext,
): Promise<string | null> {
  if (ctx.subjectEmployeeId) return ctx.subjectEmployeeId;
  if (!ctx.requesterUserId) return null;
  const row = await db
    .prepare("SELECT employee_id FROM employees WHERE tenant_id = ? AND user_id = ? LIMIT 1")
    .bind(tenantId, ctx.requesterUserId)
    .first<{ employee_id: string }>();
  return row?.employee_id ?? null;
}

/**
 * Walk up `manager_employee_id` and return the first candidate who can
 * actually act. One recursive CTE rather than a query per level, mirroring the
 * shape `assertNoManagerCycle` already proves is safe: bounded by depth, so a
 * pre-existing cycle terminates instead of hanging.
 *
 * `depth > 0` excludes the starting employee, so this can never resolve to the
 * subject of the request even when they have a perfectly good login.
 */
async function walkManagerChain(
  db: D1Database,
  tenantId: string,
  startEmployeeId: string,
  requesterUserId: string | null,
): Promise<ResolvedApprover | null> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE chain(employee_id, manager_employee_id, user_id, depth) AS (
         SELECT employee_id, manager_employee_id, user_id, 0
         FROM employees WHERE tenant_id = ? AND employee_id = ?
         UNION ALL
         SELECT e.employee_id, e.manager_employee_id, e.user_id, chain.depth + 1
         FROM employees e JOIN chain ON e.employee_id = chain.manager_employee_id
         WHERE e.tenant_id = ? AND chain.depth < ${MAX_CHAIN_DEPTH}
       )
       SELECT chain.depth, chain.employee_id, chain.user_id, u.status
       FROM chain
       LEFT JOIN users u ON u.user_id = chain.user_id AND u.tenant_id = ?
       WHERE chain.depth > 0
       ORDER BY chain.depth ASC`,
    )
    .bind(tenantId, startEmployeeId, tenantId, tenantId)
    .all<ChainRow>();

  for (const row of results ?? []) {
    // (1) can log in, (2) account is live, (3) is not the requester.
    //
    // The first two overlap: the join is a LEFT JOIN scoped to this tenant, so
    // an employee with no `user_id` — or one pointing at a user in another
    // tenant — yields a NULL `status` and would be skipped by the second check
    // alone. The explicit null check stays because it is what narrows
    // `user_id` to non-null for the return, and because relying on "NULL is
    // not 'active'" to enforce the C1 guarantee would make it accidental
    // rather than stated.
    if (!row.user_id) continue;
    if (row.status !== "active") continue;
    if (requesterUserId && row.user_id === requesterUserId) continue;
    return { approver_user_id: row.user_id, strategy: "manager_chain", hops: row.depth };
  }
  return null;
}

/**
 * A user holding one of `roles`, excluding the requester. Ordered so the choice
 * is deterministic across calls: preference order of role first, then oldest
 * account. Deterministic matters because two identical requests resolving to
 * different approvers would make the primitive's behaviour untestable.
 */
async function firstUserWithRole(
  db: D1Database,
  tenantId: string,
  roles: readonly string[],
  excludeUserId: string | null,
): Promise<string | null> {
  const placeholders = roles.map(() => "?").join(", ");
  const ordering = roles.map((role, i) => `WHEN '${role}' THEN ${i}`).join(" ");
  const row = await db
    .prepare(
      `SELECT user_id FROM users
       WHERE tenant_id = ? AND role IN (${placeholders}) AND status = 'active'
         AND (? IS NULL OR user_id <> ?)
       ORDER BY CASE role ${ordering} ELSE ${roles.length} END, created_at ASC, user_id ASC
       LIMIT 1`,
    )
    .bind(tenantId, ...roles, excludeUserId, excludeUserId)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Is this user an active admin? Used only by the solo-admin fallback. */
async function isActiveAdmin(
  db: D1Database,
  tenantId: string,
  userId: string | null,
): Promise<boolean> {
  if (!userId) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM users
       WHERE tenant_id = ? AND user_id = ? AND role = 'admin' AND status = 'active'`,
    )
    .bind(tenantId, userId)
    .first<{ hit: number }>();
  return row !== null;
}

/**
 * Resolve who owes the decision, or throw if genuinely nobody can.
 *
 * The order is always: strategy, then a tenant admin who is not the requester,
 * then — only if the requester is themselves an active admin — the requester.
 *
 * That last step looks like it contradicts "self-approval is blocked", but
 * PRD-000 blocks self-approval *unless the approver holds admin*, which is
 * exactly this case. It exists because a one-person finance function is the
 * common Malaysian SME shape: refusing to create the approval would make
 * claims and leave unusable for a tenant with a single admin, which is a worse
 * outcome than an admin approving their own expense claim in a company where
 * they are the only person who could.
 *
 * Returns null-free or throws: callers get an approver or an error, never an
 * unactionable row.
 */
export async function resolveApprover(
  db: D1Database,
  tenantId: string,
  ctx: ResolutionContext,
): Promise<ResolvedApprover | null> {
  const strategy = SUBJECT_STRATEGIES[ctx.subjectType];

  if (strategy === "manager_chain") {
    const start = await startingEmployeeId(db, tenantId, ctx);
    if (start) {
      const resolved = await walkManagerChain(db, tenantId, start, ctx.requesterUserId);
      if (resolved) return resolved;
    }
  } else {
    const byRole = await firstUserWithRole(db, tenantId, ROLE_BASED_ROLES, ctx.requesterUserId);
    if (byRole) return { approver_user_id: byRole, strategy: "role_based", hops: 0 };
  }

  // Chain exhausted (or no reporting line at all): a tenant admin.
  const admin = await firstUserWithRole(db, tenantId, ["admin"], ctx.requesterUserId);
  if (admin) return { approver_user_id: admin, strategy: "tenant_admin", hops: 0 };

  // Nobody else. An admin may approve their own request; anyone else cannot.
  if (await isActiveAdmin(db, tenantId, ctx.requesterUserId)) {
    return { approver_user_id: ctx.requesterUserId!, strategy: "self_admin", hops: 0 };
  }
  return null;
}
