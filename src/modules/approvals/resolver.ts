import type { Role } from "../../auth/roles";
import { getEmployee, getEmployeeByUserId } from "../people/service";

/**
 * Approver resolution — who is asked to decide a given approval.
 *
 * PRD-000 makes this a **pluggable strategy per `subject_type`**, because the
 * two halves of the platform route approvals through different graphs and both
 * have to work:
 *
 * - **Leave and claims** route through the *employee graph*: your manager
 *   decides, via `employees.manager_employee_id`.
 * - **Quotes and invoices** route through *platform roles*: whoever holds the
 *   money (`finance`, or `admin`) decides.
 *
 * They meet at a person who needs a login to act, which is why the manager
 * chain is walked until it finds an employee with a linked, enabled
 * `employees.user_id` rather than stopping at the first manager. An employee
 * record with no login cannot approve anything.
 *
 * This lands ahead of the `approvals` table (PRD-008 before PRD-000) so the
 * role model can be proven against both strategies now; PRD-000's
 * `requestApproval()` calls straight into `resolveApprover()`, and its
 * `decide()` owns the separate question of whether the caller *may* decide.
 */

/** Extended per consuming module, matching PRD-000's `subject_type` enum. */
export type ApprovalSubjectType = "leave_request" | "expense_claim" | "quote" | "invoice";

/** How an approver was arrived at — recorded so the audit trail can explain it. */
export type ApproverStrategy = "manager_chain" | "role_based" | "admin_fallback";

export interface ApproverResolution {
  approver_user_id: string;
  strategy: ApproverStrategy;
  /** Set when the requester was skipped over — PRD-000's self-approval rule. */
  skipped_self?: true;
}

/** Guards against a malformed reporting line surviving `assertNoManagerCycle`. */
const MAX_CHAIN_DEPTH = 20;

interface UserRow {
  user_id: string;
  role: Role;
  status: "active" | "disabled";
}

/**
 * `subject_type` → strategy. Leave and claims are people decisions; quote and
 * invoice are money decisions. A new subject type must be added here, and the
 * exhaustive switch in `resolveApprover` makes forgetting it a type error.
 */
const STRATEGY: Record<ApprovalSubjectType, "manager_chain" | "role_based"> = {
  leave_request: "manager_chain",
  expense_claim: "manager_chain",
  quote: "role_based",
  invoice: "role_based",
};

/**
 * Roles that may approve money, in the order they are preferred: finance owns
 * the decision day to day, admins are the backstop.
 */
const MONEY_APPROVER_ROLES: Role[] = ["finance", "admin"];

async function getUser(db: D1Database, tenantId: string, userId: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT user_id, role, status FROM users WHERE tenant_id = ? AND user_id = ?")
    .bind(tenantId, userId)
    .first<UserRow>();
}

/** Can this login act at all? A disabled account can never be an approver. */
function isEligible(user: UserRow | null): user is UserRow {
  return user !== null && user.status === "active";
}

/**
 * Candidate approvers holding one of `roles`, ordered by the role precedence in
 * `roles` and then by creation order — so resolution is deterministic rather
 * than dependent on row order.
 */
async function usersWithRoles(
  db: D1Database,
  tenantId: string,
  roles: Role[],
): Promise<UserRow[]> {
  const placeholders = roles.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT user_id, role, status FROM users
       WHERE tenant_id = ? AND status = 'active' AND role IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .bind(tenantId, ...roles)
    .all<UserRow>();
  return [...results].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role));
}

/** Any admin who can act — the universal fallback when no strategy resolves. */
async function adminFallback(
  db: D1Database,
  tenantId: string,
  requesterUserId: string,
  requesterIsAdmin: boolean,
): Promise<ApproverResolution | null> {
  const admins = await usersWithRoles(db, tenantId, ["admin"]);
  const other = admins.find((a) => a.user_id !== requesterUserId);
  if (other) return { approver_user_id: other.user_id, strategy: "admin_fallback" };
  // Sole admin approving their own request is the one permitted self-approval:
  // the alternative is an approval nobody in the tenant can ever decide.
  if (requesterIsAdmin && admins.some((a) => a.user_id === requesterUserId)) {
    return { approver_user_id: requesterUserId, strategy: "admin_fallback" };
  }
  return null;
}

/**
 * Walk up the reporting line from the requester's own employee record, taking
 * the first manager who is still employed *and* has an enabled login. A manager
 * who has left, or who was never given console access, is climbed past rather
 * than treated as a dead end — otherwise leave would be unapprovable for their
 * whole team.
 *
 * The requester's own login is skipped defensively. Today that branch is
 * unreachable: `idx_employees_user` makes `employees.user_id` unique per tenant,
 * so no manager row can carry the requester's login. It stays because relaxing
 * that (one person, two employment records) must not quietly enable
 * self-approval, which PRD-000 blocks for everyone but an admin.
 */
async function managerChain(
  db: D1Database,
  tenantId: string,
  requesterUserId: string,
): Promise<ApproverResolution | null> {
  const self = await getEmployeeByUserId(db, tenantId, requesterUserId);
  if (!self) return null; // no employee record → nothing to walk

  let managerId = self.manager_employee_id;
  for (let depth = 0; managerId && depth < MAX_CHAIN_DEPTH; depth++) {
    const manager = await getEmployee(db, tenantId, managerId);
    if (!manager) break;
    if (
      manager.status === "active" &&
      manager.user_id &&
      manager.user_id !== requesterUserId &&
      isEligible(await getUser(db, tenantId, manager.user_id))
    ) {
      return { approver_user_id: manager.user_id, strategy: "manager_chain" };
    }
    managerId = manager.manager_employee_id;
  }
  return null;
}

/**
 * Resolve who should decide an approval, or `null` when the tenant has nobody
 * eligible (no admin exists — only possible mid-bootstrap). Callers treat
 * `null` as "cannot route", not as "auto-approved".
 */
export async function resolveApprover(
  db: D1Database,
  tenantId: string,
  input: { subject_type: ApprovalSubjectType; requested_by_user_id: string },
): Promise<ApproverResolution | null> {
  const requester = await getUser(db, tenantId, input.requested_by_user_id);
  const requesterIsAdmin = requester?.role === "admin";

  if (STRATEGY[input.subject_type] === "manager_chain") {
    const viaManager = await managerChain(db, tenantId, input.requested_by_user_id);
    if (viaManager) return viaManager;
    // No manager, no login on the chain, or no employee record at all → admin.
    return adminFallback(db, tenantId, input.requested_by_user_id, requesterIsAdmin);
  }

  const candidates = await usersWithRoles(db, tenantId, MONEY_APPROVER_ROLES);
  const other = candidates.find((u) => u.user_id !== input.requested_by_user_id);
  if (other) {
    // A finance user raising a quote is routed past themselves to the next
    // eligible approver, and the skip is recorded rather than inferred later.
    const selfWasCandidate = candidates.some((u) => u.user_id === input.requested_by_user_id);
    return {
      approver_user_id: other.user_id,
      strategy: "role_based",
      ...(selfWasCandidate ? { skipped_self: true as const } : {}),
    };
  }
  return adminFallback(db, tenantId, input.requested_by_user_id, requesterIsAdmin);
}
