import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { arAging, type DashboardSummary } from "../src/modules/insights/service";

/** Phase B — cross-module insight aggregates for the operator dashboard. */

const API_KEY = "test_api_key_insights";
const TENANT = "biz_insights";
const OTHER_KEY = "test_api_key_insights_other";
const OTHER = "biz_insights_other";

async function get(path: string, key = API_KEY): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://gateway.test${path}`, { headers: { Authorization: `Bearer ${key}` } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function run(sql: string, ...binds: unknown[]): Promise<void> {
  await env.DB.prepare(sql).bind(...binds).run();
}

beforeAll(async () => {
  for (const [tenant, key] of [
    [TENANT, API_KEY],
    [OTHER, OTHER_KEY],
  ] as const) {
    await run("INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)", tenant, "T", await sha256Hex(key));
  }
  await run("INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)", "cust_i", TENANT, "C", "2026-01-01T00:00:00Z");

  // Invoices: two overdue, one sent (current), one paid (excluded from AR).
  const inv = (id: string, status: string, cents: number, due: string) =>
    run(
      "INSERT INTO invoices (invoice_id, tenant_id, customer_id, status, amount_due_cents, currency, due_date) VALUES (?, ?, ?, ?, ?, 'MYR', ?)",
      id, TENANT, "cust_i", status, cents, due,
    );
  await inv("inv_o1", "overdue", 30_000, "2026-01-01");
  await inv("inv_o2", "overdue", 20_000, "2026-06-20");
  await inv("inv_s1", "sent", 10_000, "2099-01-01");
  await inv("inv_p1", "paid", 99_999, "2026-01-01");

  // Ledger: a revenue posting (Dr AR / Cr Revenue) in 2026-07 for MYR 450.00.
  await run("INSERT INTO accounts (account_id, tenant_id, code, name, type, is_system) VALUES (?, ?, '1100', 'AR', 'asset', 1)", "acct_ar", TENANT);
  await run("INSERT INTO accounts (account_id, tenant_id, code, name, type, is_system) VALUES (?, ?, '4000', 'Revenue', 'revenue', 1)", "acct_rev", TENANT);
  await run("INSERT INTO journal_entries (entry_id, tenant_id, entry_date, currency, source_type) VALUES (?, ?, '2026-07-05', 'MYR', 'invoice')", "je_1", TENANT);
  await run("INSERT INTO journal_lines (entry_id, tenant_id, line_no, account_id, amount_cents) VALUES ('je_1', ?, 1, 'acct_ar', 45000)", TENANT);
  await run("INSERT INTO journal_lines (entry_id, tenant_id, line_no, account_id, amount_cents) VALUES ('je_1', ?, 2, 'acct_rev', -45000)", TENANT);

  // Deals: two open (Lead 5000.00, Proposal 2500.00), one won (excluded).
  await run("INSERT INTO pipeline_stages (stage_id, tenant_id, name, sort_order) VALUES ('stg_lead', ?, 'Lead', 1)", TENANT);
  await run("INSERT INTO pipeline_stages (stage_id, tenant_id, name, sort_order) VALUES ('stg_prop', ?, 'Proposal', 3)", TENANT);
  const deal = (id: string, cents: number, stage: string, status: string) =>
    run("INSERT INTO deals (deal_id, tenant_id, customer_id, title, value_cents, currency, stage_id, status) VALUES (?, ?, 'cust_i', 'D', ?, 'MYR', ?, ?)", id, TENANT, cents, stage, status);
  await deal("deal_1", 500_000, "stg_lead", "open");
  await deal("deal_2", 250_000, "stg_prop", "open");
  await deal("deal_3", 111_111, "stg_prop", "won");

  // Tickets: 3 open-ish (open/high, open/low, pending/normal), 1 closed.
  const tkt = (id: string, status: string, priority: string) =>
    run("INSERT INTO tickets (ticket_id, tenant_id, customer_id, subject, status, priority) VALUES (?, ?, 'cust_i', 'S', ?, ?)", id, TENANT, status, priority);
  await tkt("tkt_1", "open", "high");
  await tkt("tkt_2", "open", "low");
  await tkt("tkt_3", "pending", "normal");
  await tkt("tkt_4", "closed", "normal");

  // Issues: 2 active (todo, in_progress), 2 settled (done, cancelled).
  await run("INSERT INTO projects (project_id, tenant_id, name) VALUES ('prj_1', ?, 'P')", TENANT);
  const iss = (id: string, status: string) =>
    run("INSERT INTO issues (issue_id, tenant_id, project_id, title, status) VALUES (?, ?, 'prj_1', 'I', ?)", id, TENANT, status);
  await iss("iss_1", "todo");
  await iss("iss_2", "in_progress");
  await iss("iss_3", "done");
  await iss("iss_4", "cancelled");
});

describe("GET /v1/insights/summary", () => {
  it("aggregates the four dashboard KPIs server-side", async () => {
    const res = await get("/v1/insights/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardSummary;

    expect(body.overdue_invoices.count).toBe(2);
    expect(body.overdue_invoices.by_currency).toEqual([{ currency: "MYR", count: 2, cents: 50_000 }]);
    expect(body.open_deals.count).toBe(2);
    expect(body.open_deals.by_currency).toEqual([{ currency: "MYR", count: 2, cents: 750_000 }]);
    expect(body.open_tickets.count).toBe(3);
    expect(body.open_tickets.by_priority).toEqual({ high: 1, low: 1, normal: 1 });
    expect(body.active_issues.count).toBe(2);
    expect(body.active_issues.by_status).toEqual({ todo: 1, in_progress: 1 });
  });

  it("is tenant-scoped (a fresh tenant sees zeros)", async () => {
    const body = (await (await get("/v1/insights/summary", OTHER_KEY)).json()) as DashboardSummary;
    expect(body.overdue_invoices.count).toBe(0);
    expect(body.open_deals.count).toBe(0);
    expect(body.active_issues.count).toBe(0);
  });
});

describe("AR aging", () => {
  it("buckets outstanding invoices by days past due", async () => {
    const buckets = await arAging(env.DB, TENANT, new Date("2026-07-13T00:00:00Z"));
    expect(buckets).toEqual([
      { bucket: "current", count: 1, cents: 10_000 }, // inv_s1, due 2099
      { bucket: "1-30", count: 1, cents: 20_000 }, // inv_o2, 23 days
      { bucket: "31-60", count: 0, cents: 0 },
      { bucket: "60+", count: 1, cents: 30_000 }, // inv_o1, ~193 days
    ]);
  });
});

describe("revenue + pipeline + tickets", () => {
  it("reports recognized revenue by month from the ledger", async () => {
    const body = (await (await get("/v1/insights/revenue")).json()) as {
      points: { period: string; revenue_cents: number }[];
    };
    expect(body.points).toContainEqual({ period: "2026-07", revenue_cents: 45_000 });
  });

  it("reports open deal value by stage", async () => {
    const body = (await (await get("/v1/insights/pipeline")).json()) as {
      stages: { stage_name: string; count: number; value_cents: number }[];
    };
    expect(body.stages).toEqual([
      { stage_id: "stg_lead", stage_name: "Lead", currency: "MYR", count: 1, value_cents: 500_000 },
      { stage_id: "stg_prop", stage_name: "Proposal", currency: "MYR", count: 1, value_cents: 250_000 },
    ]);
  });

  it("summarizes open tickets with an oldest-age signal", async () => {
    const body = (await (await get("/v1/insights/tickets")).json()) as {
      by_status: Record<string, number>;
      by_priority: Record<string, number>;
      oldest_open_days: number | null;
    };
    expect(body.by_status).toEqual({ open: 2, pending: 1, closed: 1 });
    expect(body.by_priority).toEqual({ high: 1, low: 1, normal: 1 });
    expect(body.oldest_open_days).not.toBeNull();
  });

  it("insights require auth", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://gateway.test/v1/insights/summary"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
