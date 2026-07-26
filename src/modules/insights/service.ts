import { DEPARTMENTS } from "../../departments/registry";

/**
 * Insights — server-side read-models for the operator dashboard.
 *
 * Humans want answers (totals, aging, trends), not raw paginated lists. These
 * are plain SQL aggregates over the single D1 database — the "one database"
 * payoff: finance × CRM × support × build without any integration. All queries
 * are tenant-scoped and read-only.
 */

interface CurrencyBucket {
  currency: string;
  count: number;
  cents: number;
}

export interface DashboardSummary {
  overdue_invoices: { count: number; by_currency: CurrencyBucket[] };
  open_deals: { count: number; by_currency: CurrencyBucket[] };
  open_tickets: { count: number; by_priority: Record<string, number> };
  active_issues: { count: number; by_status: Record<string, number> };
}

async function currencyBuckets(
  db: D1Database,
  sql: string,
  tenantId: string,
): Promise<{ count: number; by_currency: CurrencyBucket[] }> {
  const { results } = await db.prepare(sql).bind(tenantId).all<CurrencyBucket>();
  return { count: results.reduce((n, r) => n + r.count, 0), by_currency: results };
}

async function countByKey(
  db: D1Database,
  sql: string,
  tenantId: string,
): Promise<{ count: number; by: Record<string, number> }> {
  const { results } = await db.prepare(sql).bind(tenantId).all<{ key: string; count: number }>();
  const by: Record<string, number> = {};
  let count = 0;
  for (const r of results) {
    by[r.key] = r.count;
    count += r.count;
  }
  return { count, by };
}

export async function dashboardSummary(db: D1Database, tenantId: string): Promise<DashboardSummary> {
  const [overdue, deals, tickets, issues] = await Promise.all([
    currencyBuckets(
      db,
      `SELECT currency, COUNT(*) AS count, COALESCE(SUM(amount_due_cents), 0) AS cents
       FROM invoices WHERE tenant_id = ? AND status = 'overdue' GROUP BY currency`,
      tenantId,
    ),
    currencyBuckets(
      db,
      `SELECT currency, COUNT(*) AS count, COALESCE(SUM(value_cents), 0) AS cents
       FROM deals WHERE tenant_id = ? AND status = 'open' GROUP BY currency`,
      tenantId,
    ),
    countByKey(
      db,
      `SELECT priority AS key, COUNT(*) AS count
       FROM tickets WHERE tenant_id = ? AND status != 'closed' GROUP BY priority`,
      tenantId,
    ),
    countByKey(
      db,
      `SELECT status AS key, COUNT(*) AS count
       FROM issues WHERE tenant_id = ? AND status NOT IN ('done', 'cancelled') GROUP BY status`,
      tenantId,
    ),
  ]);

  return {
    overdue_invoices: overdue,
    open_deals: deals,
    open_tickets: { count: tickets.count, by_priority: tickets.by },
    active_issues: { count: issues.count, by_status: issues.by },
  };
}

export interface ArAgingBucket {
  bucket: "current" | "1-30" | "31-60" | "60+";
  count: number;
  cents: number;
}

/**
 * Accounts-receivable aging: outstanding (issued, unpaid) invoices bucketed by
 * days past due. `now` is injectable so tests are deterministic.
 */
export async function arAging(
  db: D1Database,
  tenantId: string,
  now: Date = new Date(),
): Promise<ArAgingBucket[]> {
  const nowIso = now.toISOString();
  const { results } = await db
    .prepare(
      `SELECT
         CASE
           WHEN julianday(?) - julianday(due_date) <= 0 THEN 'current'
           WHEN julianday(?) - julianday(due_date) <= 30 THEN '1-30'
           WHEN julianday(?) - julianday(due_date) <= 60 THEN '31-60'
           ELSE '60+'
         END AS bucket,
         COUNT(*) AS count,
         COALESCE(SUM(amount_due_cents), 0) AS cents
       FROM invoices
       WHERE tenant_id = ? AND status IN ('sent', 'overdue', 'partially_paid')
       GROUP BY bucket`,
    )
    .bind(nowIso, nowIso, nowIso, tenantId)
    .all<ArAgingBucket>();

  const order: ArAgingBucket["bucket"][] = ["current", "1-30", "31-60", "60+"];
  const byBucket = new Map(results.map((r) => [r.bucket, r]));
  return order.map((b) => byBucket.get(b) ?? { bucket: b, count: 0, cents: 0 });
}

export interface RevenuePoint {
  period: string; // YYYY-MM
  revenue_cents: number;
}

/**
 * Revenue over time from the ledger: revenue accounts are credited (negative
 * signed cents), so recognized revenue is the negated sum of postings to
 * type='revenue' accounts, grouped by entry month.
 */
export async function revenueByMonth(db: D1Database, tenantId: string): Promise<RevenuePoint[]> {
  const { results } = await db
    .prepare(
      `SELECT substr(je.entry_date, 1, 7) AS period,
              -COALESCE(SUM(jl.amount_cents), 0) AS revenue_cents
       FROM journal_lines jl
       JOIN accounts a ON a.tenant_id = jl.tenant_id AND a.account_id = jl.account_id
       JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.entry_id = jl.entry_id
       WHERE jl.tenant_id = ? AND a.type = 'revenue'
       GROUP BY period ORDER BY period`,
    )
    .bind(tenantId)
    .all<RevenuePoint>();
  return results;
}

export interface PipelineRow {
  stage_id: string;
  stage_name: string;
  currency: string;
  count: number;
  value_cents: number;
}

/** Open deal value by pipeline stage (and currency, since a stage can mix). */
export async function pipelineByStage(db: D1Database, tenantId: string): Promise<PipelineRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.stage_id AS stage_id, s.name AS stage_name, d.currency AS currency,
              COUNT(*) AS count, COALESCE(SUM(d.value_cents), 0) AS value_cents
       FROM deals d
       JOIN pipeline_stages s ON s.tenant_id = d.tenant_id AND s.stage_id = d.stage_id
       WHERE d.tenant_id = ? AND d.status = 'open'
       GROUP BY s.stage_id, d.currency
       ORDER BY s.sort_order`,
    )
    .bind(tenantId)
    .all<PipelineRow>();
  return results;
}

export type ProfitabilityGroupBy = "project" | "customer" | "department";

export interface ProfitabilityRow {
  /** Dimension value, or null for the Unallocated bucket. */
  key: string | null;
  /** Human label: project/customer name, department label, or "Unallocated". */
  label: string;
  revenue_cents: number;
  cost_cents: number;
  margin_cents: number;
  /** margin ÷ revenue as a percentage, rounded to 1dp. Null when revenue is 0. */
  margin_pct: number | null;
}

/** Dimension column and the name lookup for each grouping axis. */
const PROFITABILITY_AXES: Record<
  ProfitabilityGroupBy,
  { column: string; join?: { table: string; key: string; name: string } }
> = {
  project: {
    column: "jl.project_id",
    join: { table: "projects", key: "project_id", name: "name" },
  },
  customer: {
    column: "jl.customer_id",
    join: { table: "customers", key: "customer_id", name: "name" },
  },
  // Departments live in the in-code registry, not a table, so the label is
  // resolved in TypeScript after the aggregate.
  department: { column: "jl.department_code" },
};

interface ProfitabilityAggregate {
  key: string | null;
  label: string | null;
  revenue_cents: number;
  cost_cents: number;
}

/**
 * Profitability by dimension: revenue, direct cost, margin and margin %.
 *
 * Read-only SQL over the dimensioned ledger (PRD-001a) — there is no write path
 * and no new table, which is the whole point of putting dimensions on the line.
 *
 * Sign convention: revenue accounts are credited (negative signed cents) so
 * recognised revenue is the negated sum; expense accounts are debited
 * (positive) so cost is the plain sum. Reversals carry their original
 * dimensions, so a reversed entry nets to zero inside its own bucket rather
 * than stranding one leg in Unallocated.
 *
 * "Direct cost" here means dimensioned expense postings only. Labour cost from
 * an employee rate × logged time is deliberately excluded — CompanyOS has no
 * time tracking, and PRD-001 says that would be its own PRD.
 *
 * Untagged lines are grouped under an explicit Unallocated bucket rather than
 * dropped, so the rollup's revenue always reconciles to total revenue.
 */
export async function profitability(
  db: D1Database,
  tenantId: string,
  groupBy: ProfitabilityGroupBy,
): Promise<ProfitabilityRow[]> {
  const axis = PROFITABILITY_AXES[groupBy];
  const labelSelect = axis.join ? `dim.${axis.join.name} AS label` : "NULL AS label";
  const labelJoin = axis.join
    ? `LEFT JOIN ${axis.join.table} dim
         ON dim.tenant_id = jl.tenant_id AND dim.${axis.join.key} = ${axis.column}`
    : "";

  const { results } = await db
    .prepare(
      `SELECT ${axis.column} AS key,
              ${labelSelect},
              -COALESCE(SUM(CASE WHEN a.type = 'revenue' THEN jl.amount_cents END), 0) AS revenue_cents,
               COALESCE(SUM(CASE WHEN a.type = 'expense' THEN jl.amount_cents END), 0) AS cost_cents
       FROM journal_lines jl
       JOIN accounts a ON a.tenant_id = jl.tenant_id AND a.account_id = jl.account_id
       ${labelJoin}
       WHERE jl.tenant_id = ? AND a.type IN ('revenue', 'expense')
       GROUP BY ${axis.column}`,
    )
    .bind(tenantId)
    .all<ProfitabilityAggregate>();

  const rows = results.map((r) => {
    const margin = r.revenue_cents - r.cost_cents;
    return {
      key: r.key,
      label: profitabilityLabel(groupBy, r),
      revenue_cents: r.revenue_cents,
      cost_cents: r.cost_cents,
      margin_cents: margin,
      margin_pct:
        r.revenue_cents === 0 ? null : Math.round((margin / r.revenue_cents) * 1000) / 10,
    };
  });
  // Sorted here rather than in SQL: margin is derived after the aggregate, and
  // Unallocated is pinned last so it reads as a residual, not a competitor.
  return rows.sort((a, b) => {
    if ((a.key === null) !== (b.key === null)) return a.key === null ? 1 : -1;
    return b.margin_cents - a.margin_cents;
  });
}

function profitabilityLabel(
  groupBy: ProfitabilityGroupBy,
  row: ProfitabilityAggregate,
): string {
  if (row.key === null) return "Unallocated";
  if (groupBy === "department") {
    return DEPARTMENTS.find((d) => d.id === row.key)?.label ?? row.key;
  }
  // A dimension can outlive the row it names (a customer is archived, a project
  // is deleted). Fall back to the raw id rather than dropping the bucket — the
  // money still happened.
  return row.label ?? row.key;
}

export interface TicketInsights {
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  oldest_open_days: number | null;
}

/** Open-ticket load by status/priority plus a coarse SLA signal (oldest age). */
export async function ticketInsights(
  db: D1Database,
  tenantId: string,
  now: Date = new Date(),
): Promise<TicketInsights> {
  const [byStatus, byPriority, oldest] = await Promise.all([
    countByKey(
      db,
      `SELECT status AS key, COUNT(*) AS count FROM tickets WHERE tenant_id = ? GROUP BY status`,
      tenantId,
    ),
    countByKey(
      db,
      `SELECT priority AS key, COUNT(*) AS count
       FROM tickets WHERE tenant_id = ? AND status != 'closed' GROUP BY priority`,
      tenantId,
    ),
    db
      .prepare(
        `SELECT MIN(created_at) AS oldest FROM tickets WHERE tenant_id = ? AND status != 'closed'`,
      )
      .bind(tenantId)
      .first<{ oldest: string | null }>(),
  ]);

  let oldest_open_days: number | null = null;
  if (oldest?.oldest) {
    const days = (now.getTime() - Date.parse(oldest.oldest)) / 86_400_000;
    oldest_open_days = Math.max(0, Math.floor(days));
  }
  return { by_status: byStatus.by, by_priority: byPriority.by, oldest_open_days };
}
