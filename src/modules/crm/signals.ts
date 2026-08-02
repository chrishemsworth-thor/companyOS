/**
 * PRD-003 — the cross-module facts about one customer, in ONE query.
 *
 * "No more than one additional query on the customer detail endpoint" is an
 * acceptance criterion, not a preference, so this is a single SELECT of scalar
 * subqueries rather than a query per input. Everything it reads already exists:
 * invoices, tickets, activities and deals. That is the differentiator PRD-003
 * opens with — *"the CRM record knows things no standalone CRM can know"* —
 * and it is only cheap because one database owns all four.
 *
 * The same row backs two features: the credit-limit warning (outstanding AR)
 * and the health band (everything else). They share a query deliberately; two
 * would blow the budget.
 */

export interface CustomerSignals {
  /** Everything not yet paid — the denominator for the credit-limit warning. */
  outstanding_ar_cents: number;
  overdue_count: number;
  overdue_cents: number;
  /** Days past due of the OLDEST overdue invoice, 0 when none. */
  max_days_overdue: number;
  /** Overdue invoice ids, oldest first — reasons name them. */
  overdue_invoice_ids: string[];
  open_ticket_count: number;
  /** Age in days of the oldest open ticket, 0 when none. */
  oldest_open_ticket_days: number;
  /** Days since the most recent activity, null when there has never been one. */
  days_since_activity: number | null;
  open_deal_cents: number;
  /**
   * Mean days from issue to payment over settled invoices, null when none has
   * been paid yet. Compared against the customer's own terms, not a constant.
   */
  dso_days: number | null;
  /** The customer's terms, resolved the same way invoice due dates resolve. */
  payment_terms_days: number;
  /** Null means "no limit set", which is not the same as a limit of zero. */
  credit_limit_cents: number | null;
  /** Have we ever invoiced, ticketed or touched this customer at all? */
  has_history: boolean;
}

interface SignalsRow {
  customer_id: string;
  outstanding_ar_cents: number | null;
  overdue_count: number | null;
  overdue_cents: number | null;
  max_days_overdue: number | null;
  overdue_invoice_ids: string | null;
  open_ticket_count: number | null;
  oldest_open_ticket_days: number | null;
  days_since_activity: number | null;
  open_deal_cents: number | null;
  dso_days: number | null;
  customer_terms: number | null;
  tenant_terms: number | null;
  credit_limit_cents: number | null;
  invoice_count: number | null;
  ticket_count: number | null;
  activity_count: number | null;
}

/**
 * Exposure, for the credit-limit warning. Includes `draft` deliberately:
 * `createInvoice` posts the Dr AR leg at creation, so the ledger already counts
 * a draft as receivable, and a credit warning that only fires after the invoice
 * is sent fires too late to be worth having.
 */
const OUTSTANDING_INVOICE_STATES = "('draft', 'sent', 'overdue', 'partially_paid')";

/**
 * Overdue, for health. Excludes `draft`: an invoice nobody has sent cannot be
 * late, whatever its due date says. Matches the overdue sweep, which only
 * considers `sent`.
 */
const OVERDUE_INVOICE_STATES = "('sent', 'overdue', 'partially_paid')";

/**
 * One row per customer, driven off `customers` so the subqueries correlate on
 * `c.customer_id`. That is what lets ONE query serve both the detail endpoint
 * (a single customer) and the customer list (a whole page of health badges) —
 * the alternative, a query per row, is exactly what the acceptance criterion
 * forbids and what would make the list page unusable.
 *
 * `?2` is a single customer id or NULL for "every customer at this tenant".
 * `now` is passed in rather than read as `CURRENT_TIMESTAMP` so every derived
 * age in one response is measured against the same instant, and so tests can
 * pin it.
 */
const SIGNALS_SQL = `
SELECT
  c.customer_id AS customer_id,
  (SELECT COALESCE(SUM(amount_due_cents), 0) FROM invoices
    WHERE tenant_id = ?1 AND customer_id = c.customer_id
      AND status IN ${OUTSTANDING_INVOICE_STATES}) AS outstanding_ar_cents,

  (SELECT COUNT(*) FROM invoices
    WHERE tenant_id = ?1 AND customer_id = c.customer_id
      AND status IN ${OVERDUE_INVOICE_STATES} AND amount_due_cents > 0
      AND julianday(?3) > julianday(due_date)) AS overdue_count,

  (SELECT COALESCE(SUM(amount_due_cents), 0) FROM invoices
    WHERE tenant_id = ?1 AND customer_id = c.customer_id
      AND status IN ${OVERDUE_INVOICE_STATES} AND amount_due_cents > 0
      AND julianday(?3) > julianday(due_date)) AS overdue_cents,

  (SELECT COALESCE(MAX(CAST(julianday(?3) - julianday(due_date) AS INTEGER)), 0) FROM invoices
    WHERE tenant_id = ?1 AND customer_id = c.customer_id
      AND status IN ${OVERDUE_INVOICE_STATES} AND amount_due_cents > 0
      AND julianday(?3) > julianday(due_date)) AS max_days_overdue,

  (SELECT group_concat(invoice_id) FROM (
     SELECT invoice_id FROM invoices
      WHERE tenant_id = ?1 AND customer_id = c.customer_id
        AND status IN ${OVERDUE_INVOICE_STATES} AND amount_due_cents > 0
        AND julianday(?3) > julianday(due_date)
      ORDER BY due_date)) AS overdue_invoice_ids,

  (SELECT COUNT(*) FROM tickets
    WHERE tenant_id = ?1 AND customer_id = c.customer_id
      AND status IN ('open', 'pending')) AS open_ticket_count,

  (SELECT COALESCE(MAX(CAST(julianday(?3) - julianday(created_at) AS INTEGER)), 0) FROM tickets
    WHERE tenant_id = ?1 AND customer_id = c.customer_id
      AND status IN ('open', 'pending')) AS oldest_open_ticket_days,

  (SELECT CAST(julianday(?3) - julianday(MAX(occurred_at)) AS INTEGER) FROM activities
    WHERE tenant_id = ?1 AND customer_id = c.customer_id) AS days_since_activity,

  (SELECT COALESCE(SUM(value_cents), 0) FROM deals
    WHERE tenant_id = ?1 AND customer_id = c.customer_id AND status = 'open') AS open_deal_cents,

  (SELECT AVG(julianday(paid_at) - julianday(issued_at)) FROM invoices
    WHERE tenant_id = ?1 AND customer_id = c.customer_id
      AND status = 'paid' AND paid_at IS NOT NULL AND issued_at IS NOT NULL) AS dso_days,

  c.payment_terms_days AS customer_terms,
  (SELECT default_payment_terms_days FROM company_profile WHERE tenant_id = ?1) AS tenant_terms,
  c.credit_limit_cents AS credit_limit_cents,

  (SELECT COUNT(*) FROM invoices WHERE tenant_id = ?1 AND customer_id = c.customer_id) AS invoice_count,
  (SELECT COUNT(*) FROM tickets WHERE tenant_id = ?1 AND customer_id = c.customer_id) AS ticket_count,
  (SELECT COUNT(*) FROM activities WHERE tenant_id = ?1 AND customer_id = c.customer_id) AS activity_count
FROM customers c
WHERE c.tenant_id = ?1 AND (?2 IS NULL OR c.customer_id = ?2)
`;

function toSignals(row: SignalsRow): CustomerSignals {
  return {
    outstanding_ar_cents: row.outstanding_ar_cents ?? 0,
    overdue_count: row.overdue_count ?? 0,
    overdue_cents: row.overdue_cents ?? 0,
    max_days_overdue: row.max_days_overdue ?? 0,
    overdue_invoice_ids: row.overdue_invoice_ids ? row.overdue_invoice_ids.split(",") : [],
    open_ticket_count: row.open_ticket_count ?? 0,
    oldest_open_ticket_days: row.oldest_open_ticket_days ?? 0,
    days_since_activity: row.days_since_activity ?? null,
    open_deal_cents: row.open_deal_cents ?? 0,
    dso_days: row.dso_days ?? null,
    // Same precedence as invoice due dates — see finance/payment-terms.ts. Kept
    // here rather than calling resolvePaymentTermsDays() because that would be
    // the second query the acceptance criterion forbids.
    payment_terms_days: row.customer_terms ?? row.tenant_terms ?? 30,
    credit_limit_cents: row.credit_limit_cents ?? null,
    has_history:
      (row.invoice_count ?? 0) > 0 ||
      (row.ticket_count ?? 0) > 0 ||
      (row.activity_count ?? 0) > 0,
  };
}

/** Signals for one customer. One query. */
export async function getCustomerSignals(
  db: D1Database,
  tenantId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<CustomerSignals> {
  const row = await db
    .prepare(SIGNALS_SQL)
    .bind(tenantId, customerId, now.toISOString())
    .first<SignalsRow>();

  // A customer that does not exist reads as "no history" rather than throwing;
  // the caller has already 404'd on the customer itself if it cares.
  return row
    ? toSignals(row)
    : toSignals({
        outstanding_ar_cents: 0,
        overdue_count: 0,
        overdue_cents: 0,
        max_days_overdue: 0,
        overdue_invoice_ids: null,
        open_ticket_count: 0,
        oldest_open_ticket_days: 0,
        days_since_activity: null,
        open_deal_cents: 0,
        dso_days: null,
        customer_terms: null,
        tenant_terms: null,
        credit_limit_cents: null,
        invoice_count: 0,
        ticket_count: 0,
        activity_count: 0,
      } as SignalsRow);
}

/**
 * Signals for EVERY customer at the tenant, keyed by customer id — still one
 * query. This is what makes a health badge on the customer list affordable;
 * looping `getCustomerSignals` per row would be one query per customer.
 */
export async function getAllCustomerSignals(
  db: D1Database,
  tenantId: string,
  now: Date = new Date(),
): Promise<Map<string, CustomerSignals>> {
  const { results } = await db
    .prepare(SIGNALS_SQL)
    .bind(tenantId, null, now.toISOString())
    .all<SignalsRow>();
  return new Map(results.map((row) => [row.customer_id, toSignals(row)]));
}
