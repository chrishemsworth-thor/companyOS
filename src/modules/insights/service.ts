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
  /**
   * Approved expense claims not yet reimbursed (PRD-006a).
   *
   * PRD-006: "Unpaid approved claims appear as a liability and in cash-flow
   * outlook." The liability itself is already in the books — the balance of
   * `2100 Employee Reimbursements Payable` — so this is the outlook side: cash
   * the company is committed to paying its own staff that has not left yet.
   */
  unpaid_claims: { count: number; by_currency: CurrencyBucket[] };
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
  const [overdue, deals, tickets, issues, unpaidClaims] = await Promise.all([
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
    currencyBuckets(
      db,
      `SELECT currency, COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS cents
       FROM expense_claims WHERE tenant_id = ? AND status = 'approved' GROUP BY currency`,
      tenantId,
    ),
  ]);

  return {
    overdue_invoices: overdue,
    open_deals: deals,
    open_tickets: { count: tickets.count, by_priority: tickets.by },
    active_issues: { count: issues.count, by_status: issues.by },
    unpaid_claims: unpaidClaims,
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

// ---------------------------------------------------------------------------
// Agent activity (PRD-002 P0 decision observability)
//
// Everything here reads `events_log` rather than a projection table. The
// decision event is already the audit record — a second copy in a table would
// be a second thing to keep in sync, and D1's JSON1 functions make the audit
// log queryable as it stands. That is also what makes PRD-002's P2 outcome
// scoring a query later rather than a migration.
// ---------------------------------------------------------------------------

export interface AgentModelUsage {
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  decisions: number;
}

export interface AgentMonth {
  month: string;
  decisions: number;
  fallbacks: number;
  overridden: number;
  cost_micros: number;
}

export interface AgentInsights {
  period: { from: string; to: string };
  decisions: {
    total: number;
    by_action: Record<string, number>;
  };
  fallback: { count: number; rate: number };
  overrides: {
    /** Decisions a guardrail changed — the denominator of PRD-002's < 10%. */
    decisions_overridden: number;
    rate: number;
    /** Guardrail firings, which can exceed the decision count: one decision may
     * trip two rules, and the pre-send gate fires without any decision at all. */
    firings: number;
    by_guardrail: Record<string, number>;
  };
  spend: {
    /** Integer micro-USD over the priced decisions only. */
    cost_micros: number;
    priced_decisions: number;
    /** Decisions whose model had no known rate — the total excludes them, and
     * saying so is the difference between a spend figure and a guess. */
    unpriced_decisions: number;
    input_tokens: number;
    output_tokens: number;
  };
  latency_ms: { p95: number; max: number };
  models: AgentModelUsage[];
  by_month: AgentMonth[];
}

const DECISION_WHERE = `tenant_id = ? AND event_type = 'collections.decision'
  AND occurred_at >= ? AND occurred_at <= ?`;

function rate(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 10_000) / 10_000;
}

export async function agentInsights(
  db: D1Database,
  tenantId: string,
  period: { from: string; to: string },
): Promise<AgentInsights> {
  const binds = [tenantId, period.from, period.to];

  const { results: byAction } = await db
    .prepare(
      `SELECT json_extract(payload, '$.action') AS action, COUNT(*) AS n
       FROM events_log WHERE ${DECISION_WHERE} GROUP BY action`,
    )
    .bind(...binds)
    .all<{ action: string | null; n: number }>();

  const totals = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN json_extract(payload, '$.source') = 'fallback' THEN 1 ELSE 0 END) AS fallbacks,
         -- A v1 event has no guardrail_overridden; json_extract returns NULL and
         -- it counts as "not overridden", which is true: v1 predates the guard.
         SUM(CASE WHEN json_extract(payload, '$.guardrail_overridden') IN (1, 'true') THEN 1 ELSE 0 END) AS overridden,
         SUM(COALESCE(json_extract(payload, '$.input_tokens'), 0)) AS input_tokens,
         SUM(COALESCE(json_extract(payload, '$.output_tokens'), 0)) AS output_tokens,
         SUM(COALESCE(json_extract(payload, '$.cost_micros'), 0)) AS cost_micros,
         SUM(CASE WHEN json_extract(payload, '$.cost_micros') IS NULL THEN 1 ELSE 0 END) AS unpriced,
         MAX(COALESCE(json_extract(payload, '$.latency_ms'), 0)) AS max_latency
       FROM events_log WHERE ${DECISION_WHERE}`,
    )
    .bind(...binds)
    .first<{
      total: number;
      fallbacks: number | null;
      overridden: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_micros: number | null;
      unpriced: number | null;
      max_latency: number | null;
    }>();

  const total = totals?.total ?? 0;
  const unpriced = totals?.unpriced ?? 0;

  // p95 by offset rather than by reading every row into memory: nearest-rank,
  // so the number reported is a latency some request actually had.
  let p95 = 0;
  if (total > 0) {
    const offset = Math.min(Math.max(Math.ceil(total * 0.95) - 1, 0), total - 1);
    const row = await db
      .prepare(
        `SELECT COALESCE(json_extract(payload, '$.latency_ms'), 0) AS latency_ms
         FROM events_log WHERE ${DECISION_WHERE}
         ORDER BY latency_ms ASC LIMIT 1 OFFSET ?`,
      )
      .bind(...binds, offset)
      .first<{ latency_ms: number }>();
    p95 = row?.latency_ms ?? 0;
  }

  const { results: models } = await db
    .prepare(
      `SELECT json_extract(payload, '$.provider') AS provider,
              json_extract(payload, '$.model') AS model,
              json_extract(payload, '$.prompt_version') AS prompt_version,
              COUNT(*) AS decisions
       FROM events_log WHERE ${DECISION_WHERE}
       GROUP BY provider, model, prompt_version
       ORDER BY decisions DESC`,
    )
    .bind(...binds)
    .all<AgentModelUsage>();

  const { results: guardrails } = await db
    .prepare(
      `SELECT json_extract(payload, '$.guardrail') AS guardrail, COUNT(*) AS n
       FROM events_log
       WHERE tenant_id = ? AND event_type = 'guardrail.override'
         AND occurred_at >= ? AND occurred_at <= ?
       GROUP BY guardrail ORDER BY n DESC`,
    )
    .bind(...binds)
    .all<{ guardrail: string | null; n: number }>();

  const { results: months } = await db
    .prepare(
      `SELECT substr(occurred_at, 1, 7) AS month,
              COUNT(*) AS decisions,
              SUM(CASE WHEN json_extract(payload, '$.source') = 'fallback' THEN 1 ELSE 0 END) AS fallbacks,
              SUM(CASE WHEN json_extract(payload, '$.guardrail_overridden') IN (1, 'true') THEN 1 ELSE 0 END) AS overridden,
              SUM(COALESCE(json_extract(payload, '$.cost_micros'), 0)) AS cost_micros
       FROM events_log WHERE ${DECISION_WHERE}
       GROUP BY month ORDER BY month ASC`,
    )
    .bind(...binds)
    .all<AgentMonth>();

  return {
    period,
    decisions: {
      total,
      by_action: Object.fromEntries(byAction.map((r) => [r.action ?? "unknown", r.n])),
    },
    fallback: { count: totals?.fallbacks ?? 0, rate: rate(totals?.fallbacks ?? 0, total) },
    overrides: {
      decisions_overridden: totals?.overridden ?? 0,
      rate: rate(totals?.overridden ?? 0, total),
      firings: guardrails.reduce((sum, r) => sum + r.n, 0),
      by_guardrail: Object.fromEntries(guardrails.map((r) => [r.guardrail ?? "unknown", r.n])),
    },
    spend: {
      cost_micros: totals?.cost_micros ?? 0,
      priced_decisions: total - unpriced,
      unpriced_decisions: unpriced,
      input_tokens: totals?.input_tokens ?? 0,
      output_tokens: totals?.output_tokens ?? 0,
    },
    latency_ms: { p95, max: totals?.max_latency ?? 0 },
    models,
    by_month: months,
  };
}
