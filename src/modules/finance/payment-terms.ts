/**
 * PRD-003 P0 — "`payment_terms_days` (default from tenant settings), used to
 * compute invoice due dates automatically, which is the point of storing it."
 *
 * This is the one place in the codebase where a due date is derived rather than
 * supplied, and it is deliberately a finance-module file: SESSION-PLAN's
 * conflict C7 flags that this PRD-003 requirement changes a finance write path,
 * not a CRM one.
 *
 * An explicitly supplied `due_date` always wins. Every caller that existed
 * before S8 supplies one, so their behaviour is unchanged by construction —
 * which is what keeps the finance regression suites green.
 */

/** Fallback when neither the customer nor the tenant has stated terms. */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30;

/** Add whole days to an ISO date (YYYY-MM-DD), in UTC. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Terms for one customer: the customer's own value, else the tenant default
 * from `company_profile`, else 30.
 *
 * `customers.payment_terms_days` is nullable precisely so that NULL can mean
 * "use the tenant default" rather than "due immediately" — a 0 stored on the
 * customer is a real, honoured choice (due on issue).
 */
export async function resolvePaymentTermsDays(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT c.payment_terms_days AS customer_terms,
              p.default_payment_terms_days AS tenant_terms
         FROM customers c
         LEFT JOIN company_profile p ON p.tenant_id = c.tenant_id
        WHERE c.tenant_id = ? AND c.customer_id = ?`,
    )
    .bind(tenantId, customerId)
    .first<{ customer_terms: number | null; tenant_terms: number | null }>();

  return row?.customer_terms ?? row?.tenant_terms ?? DEFAULT_PAYMENT_TERMS_DAYS;
}

/**
 * The due date for an invoice: `explicit` when the caller supplied one,
 * otherwise `issueDate + resolvePaymentTermsDays()`.
 */
export async function resolveDueDate(
  db: D1Database,
  tenantId: string,
  customerId: string,
  issueDate: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  return addDays(issueDate, await resolvePaymentTermsDays(db, tenantId, customerId));
}
