import { paginate } from "../../gateway/pagination";
import type {
  ClaimDetail,
  ClaimLimitWarning,
  ClaimStatus,
  ExpenseClaim,
  ExpenseClaimLine,
  ExpenseClaimLineView,
} from "./types";

/**
 * Tenant-scoped reads over the claims tables.
 *
 * Separate from `service.ts` because `decision.ts` needs to read a claim and
 * must not import the write path: the approvals service imports the decision
 * effect, so anything `decision.ts` pulls in would become a cycle through
 * `service.ts` -> `approvals/service.ts`.
 *
 * Every query names `tenant_id` in its WHERE clause, so another tenant's id
 * resolves to nothing and the route turns that into a 404 rather than a 403 —
 * a 403 would confirm the id exists.
 */

const CLAIM_COLUMNS =
  "claim_id, tenant_id, employee_id, claim_date, description, currency, total_cents, tax_cents, " +
  "status, project_id, department_code, submitted_by, submitted_at, approval_id, " +
  "rejection_comment, rejected_at, entry_id, paid_entry_id, payment_reference, paid_at, " +
  "created_at, updated_at";

export async function getClaim(
  db: D1Database,
  tenantId: string,
  claimId: string,
): Promise<ExpenseClaim | null> {
  return db
    .prepare(`SELECT ${CLAIM_COLUMNS} FROM expense_claims WHERE tenant_id = ? AND claim_id = ?`)
    .bind(tenantId, claimId)
    .first<ExpenseClaim>();
}

export async function getClaimLines(
  db: D1Database,
  tenantId: string,
  claimId: string,
): Promise<ExpenseClaimLine[]> {
  const { results } = await db
    .prepare(
      `SELECT claim_id, line_no, category_id, description, distance_km, amount_cents, tax_cents,
              receipt_file_id, project_id, department_code
         FROM expense_claim_lines
        WHERE tenant_id = ? AND claim_id = ?
        ORDER BY line_no`,
    )
    .bind(tenantId, claimId)
    .all<ExpenseClaimLine>();
  return results ?? [];
}

/**
 * Lines with their category and receipt metadata — what an approver needs to
 * decide without opening anything else.
 *
 * The `files` join is LEFT: a receipt whose file row was soft-deleted still
 * leaves a claim that has to render. The card shows "receipt unavailable" rather
 * than failing, which is the same principle as PRD-007's "a subject that was
 * deleted renders as unavailable rather than erroring".
 */
export async function getClaimLineViews(
  db: D1Database,
  tenantId: string,
  claimId: string,
): Promise<ExpenseClaimLineView[]> {
  const { results } = await db
    .prepare(
      `SELECT l.claim_id, l.line_no, l.category_id, l.description, l.distance_km,
              l.amount_cents, l.tax_cents, l.receipt_file_id, l.project_id, l.department_code,
              cc.code AS category_code, cc.name AS category_name, cc.kind AS category_kind,
              a.code AS account_code, a.name AS account_name,
              f.filename AS receipt_filename, f.content_type AS receipt_content_type,
              f.size_bytes AS receipt_size_bytes
         FROM expense_claim_lines l
         JOIN claim_categories cc ON cc.tenant_id = l.tenant_id AND cc.category_id = l.category_id
         JOIN accounts a ON a.tenant_id = cc.tenant_id AND a.account_id = cc.expense_account_id
         LEFT JOIN files f
                ON f.tenant_id = l.tenant_id AND f.file_id = l.receipt_file_id
               AND f.deleted_at IS NULL
        WHERE l.tenant_id = ? AND l.claim_id = ?
        ORDER BY l.line_no`,
    )
    .bind(tenantId, claimId)
    .all<ExpenseClaimLineView>();
  return results ?? [];
}

/**
 * Categories on this claim whose per-claim limit is exceeded by the sum of its
 * own lines.
 *
 * Advisory only (PRD-006: "a warning is shown and the claim still submits"), so
 * this returns data and never throws. Computed on read rather than stored: a
 * limit that changed after submission should be reflected the next time somebody
 * looks, and there is nothing to keep in sync.
 */
export async function getClaimLimitWarnings(
  db: D1Database,
  tenantId: string,
  claimId: string,
): Promise<ClaimLimitWarning[]> {
  const { results } = await db
    .prepare(
      `SELECT cc.category_id, cc.code AS category_code, cc.name AS category_name,
              cc.limit_cents, SUM(l.amount_cents) AS claimed_cents
         FROM expense_claim_lines l
         JOIN claim_categories cc ON cc.tenant_id = l.tenant_id AND cc.category_id = l.category_id
        WHERE l.tenant_id = ? AND l.claim_id = ? AND cc.limit_cents IS NOT NULL
        GROUP BY cc.category_id
       HAVING SUM(l.amount_cents) > cc.limit_cents
        ORDER BY cc.name`,
    )
    .bind(tenantId, claimId)
    .all<Omit<ClaimLimitWarning, "over_by_cents">>();
  return (results ?? []).map((row) => ({
    ...row,
    over_by_cents: row.claimed_cents - row.limit_cents,
  }));
}

/** Header + lines + limit warnings, as `GET /v1/claims/:id` returns it. */
export async function getClaimDetail(
  db: D1Database,
  tenantId: string,
  claimId: string,
): Promise<ClaimDetail | null> {
  const claim = await getClaim(db, tenantId, claimId);
  if (!claim) return null;
  const [lines, limit_warnings] = await Promise.all([
    getClaimLineViews(db, tenantId, claimId),
    getClaimLimitWarnings(db, tenantId, claimId),
  ]);
  return { claim, lines, limit_warnings };
}

export interface ListClaimsFilter {
  status?: ClaimStatus;
  employee_id?: string;
  /** Restrict to claims whose live/last approval is assigned to this user. */
  approver_user_id?: string;
  limit: number;
  cursor?: string;
}

/**
 * List claims for a tenant, oldest first on the ULID claim_id — the same
 * ordering and cursor mechanics as every other list endpoint, so `paginate`
 * works on it unchanged.
 */
export async function listClaims(
  db: D1Database,
  tenantId: string,
  filter: ListClaimsFilter,
): Promise<{ claims: ExpenseClaim[]; next_cursor: string | null }> {
  const where = ["c.tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (filter.status) {
    where.push("c.status = ?");
    binds.push(filter.status);
  }
  if (filter.employee_id) {
    where.push("c.employee_id = ?");
    binds.push(filter.employee_id);
  }
  if (filter.approver_user_id) {
    // EXISTS against `approvals` rather than a join on `approval_id`: a
    // resubmitted claim has several approval rows over its life (C8), and the
    // approver of any of them may legitimately look it up.
    where.push(
      `EXISTS (SELECT 1 FROM approvals ap
                WHERE ap.tenant_id = c.tenant_id
                  AND ap.subject_type = 'expense_claim'
                  AND ap.subject_id = c.claim_id
                  AND ap.approver_user_id = ?)`,
    );
    binds.push(filter.approver_user_id);
  }
  if (filter.cursor) {
    where.push("c.claim_id > ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);

  const { results } = await db
    .prepare(
      `SELECT ${CLAIM_COLUMNS.split(", ")
        .map((col) => `c.${col}`)
        .join(", ")}
         FROM expense_claims c
        WHERE ${where.join(" AND ")}
        ORDER BY c.claim_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<ExpenseClaim>();
  const { items, next_cursor } = paginate(results ?? [], filter.limit, "claim_id");
  return { claims: items, next_cursor };
}

/**
 * Is this user the approver on any approval for this claim?
 *
 * The read behind the "an approver may see the claim they are deciding on" rule.
 * A manager routed a claim by the C1 upward walk may hold no finance or people
 * capability at all, and cannot decide without seeing the receipt.
 */
export async function isClaimApprover(
  db: D1Database,
  tenantId: string,
  claimId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM approvals
        WHERE tenant_id = ? AND subject_type = 'expense_claim' AND subject_id = ?
          AND approver_user_id = ? LIMIT 1`,
    )
    .bind(tenantId, claimId, userId)
    .first<{ hit: number }>();
  return row !== null;
}
