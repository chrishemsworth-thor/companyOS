import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * PRD-001a — analytical dimensions on the journal line, and the profitability
 * rollup they exist to make possible.
 *
 * One acceptance criterion per `it`, in the PRD's order, so a failure names the
 * requirement it broke.
 */

const API_KEY = "test_api_key_ledger_dims";
const TENANT = "biz_ledger_dims";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

const CUSTOMER = "cus_dims_acme";
const PROJECT = "prj_dims_alpha";
const EMPLOYEE = "emp_dims_aina";

async function api(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let arId = "";
let revenueId = "";
let expenseId = "";

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT, "Ledger Dimensions", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name) VALUES (?, ?, ?)",
  )
    .bind(CUSTOMER, TENANT, "Acme Sdn Bhd")
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO projects (project_id, tenant_id, name) VALUES (?, ?, ?)",
  )
    .bind(PROJECT, TENANT, "Alpha Rebrand")
    .run();

  const accounts = (await (await api("/v1/ledger/accounts", { headers: auth })).json()) as {
    accounts: { account_id: string; code: string }[];
  };
  arId = accounts.accounts.find((a) => a.code === "1100")!.account_id;
  revenueId = accounts.accounts.find((a) => a.code === "4000")!.account_id;
  expenseId = accounts.accounts.find((a) => a.code === "5000")!.account_id;
});

/** Post a manual entry; returns the response so callers can assert on status. */
function postEntry(lines: unknown[], memo = "dimension test"): Promise<Response> {
  return api("/v1/ledger/entries", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ entry_date: "2026-07-10", currency: "MYR", memo, lines }),
  });
}

describe("dimensions on journal lines", () => {
  it("stamps customer_id on both the AR and Revenue lines of an invoice", async () => {
    const res = await api("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER,
        currency: "MYR",
        due_date: "2026-08-10",
        lines: [{ description: "Consulting", quantity: 1, unit_cents: 100_000 }],
      }),
    });
    expect(res.status).toBe(201);

    const { results } = await env.DB.prepare(
      `SELECT jl.account_id, jl.customer_id FROM journal_lines jl
       JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.entry_id = jl.entry_id
       WHERE jl.tenant_id = ? AND je.source_type = 'invoice'`,
    )
      .bind(TENANT)
      .all<{ account_id: string; customer_id: string | null }>();

    expect(results).toHaveLength(2);
    // Both legs, not just revenue — the criterion names AR explicitly.
    expect(results.every((r) => r.customer_id === CUSTOMER)).toBe(true);
    expect(results.map((r) => r.account_id).sort()).toEqual([arId, revenueId].sort());
  });

  it("persists a dimension set on a manual entry, per line", async () => {
    const res = await postEntry([
      { account_id: expenseId, amount_cents: 30_000, project_id: PROJECT, employee_id: EMPLOYEE },
      { account_id: arId, amount_cents: -30_000, project_id: PROJECT },
    ]);
    expect(res.status).toBe(201);
    const { entry_id } = (await res.json()) as { entry_id: string };

    const entry = (await (await api(`/v1/ledger/entries/${entry_id}`, { headers: auth })).json()) as {
      lines: { account_id: string; project_id: string | null; employee_id: string | null }[];
    };
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines.every((l) => l.project_id === PROJECT)).toBe(true);
    // Dimensions are per line, not per entry: only the expense leg names an employee.
    expect(entry.lines.find((l) => l.account_id === expenseId)!.employee_id).toBe(EMPLOYEE);
    expect(entry.lines.find((l) => l.account_id === arId)!.employee_id).toBeNull();
  });

  it("rejects a dimension update on a posted entry, via the append-only trigger", async () => {
    const res = await postEntry([
      { account_id: expenseId, amount_cents: 5_000, project_id: PROJECT },
      { account_id: arId, amount_cents: -5_000 },
    ]);
    const { entry_id } = (await res.json()) as { entry_id: string };

    // Same mechanism that protects amount_cents — journal_lines_no_update (0002)
    // aborts any UPDATE, so dimensions inherit immutability for free.
    await expect(
      env.DB.prepare(
        "UPDATE journal_lines SET project_id = ? WHERE tenant_id = ? AND entry_id = ?",
      )
        .bind("prj_someone_elses", TENANT, entry_id)
        .run(),
    ).rejects.toThrow(/append-only/);
  });

  it("posts an entry with no dimensions at all (backwards compatible)", async () => {
    const res = await postEntry([
      { account_id: arId, amount_cents: 1_500 },
      { account_id: revenueId, amount_cents: -1_500 },
    ]);
    expect(res.status).toBe(201);
    const { entry_id } = (await res.json()) as { entry_id: string };
    const entry = (await (await api(`/v1/ledger/entries/${entry_id}`, { headers: auth })).json()) as {
      lines: { customer_id: string | null; project_id: string | null }[];
    };
    expect(entry.lines.every((l) => l.customer_id === null && l.project_id === null)).toBe(true);
  });

  it("rejects a department_code outside the registry taxonomy", async () => {
    const res = await postEntry([
      { account_id: expenseId, amount_cents: 2_000, department_code: "not-a-department" },
      { account_id: arId, amount_cents: -2_000 },
    ]);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("unknown_department");

    // Nothing was written — validation happens before the batch.
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM journal_lines WHERE tenant_id = ? AND department_code = ?",
    )
      .bind(TENANT, "not-a-department")
      .first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("accepts a department_code that is in the registry", async () => {
    const res = await postEntry([
      { account_id: expenseId, amount_cents: 2_000, department_code: "finance" },
      { account_id: arId, amount_cents: -2_000 },
    ]);
    expect(res.status).toBe(201);
  });

  it("carries dimensions onto a reversal so the bucket nets to zero", async () => {
    const posted = await postEntry(
      [
        { account_id: expenseId, amount_cents: 7_000, project_id: PROJECT },
        { account_id: arId, amount_cents: -7_000, project_id: PROJECT },
      ],
      "to be reversed",
    );
    const { entry_id } = (await posted.json()) as { entry_id: string };

    const res = await api(`/v1/ledger/entries/${entry_id}/reverse`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(201);
    const { entry_id: reversalId } = (await res.json()) as { entry_id: string };

    const reversal = (await (
      await api(`/v1/ledger/entries/${reversalId}`, { headers: auth })
    ).json()) as { lines: { amount_cents: number; project_id: string | null }[] };
    // Were the dimensions dropped here, the original's cost would stay on the
    // project while its offset landed in Unallocated.
    expect(reversal.lines.every((l) => l.project_id === PROJECT)).toBe(true);
    expect(reversal.lines.reduce((n, l) => n + l.amount_cents, 0)).toBe(0);
  });
});

describe("GET /v1/insights/profitability", () => {
  const P_PROJECT = "prj_profit_beta";

  // vitest-pool-workers runs each test in an isolated storage frame, so writes
  // made inside an `it` are rolled back before the next one. Every fixture the
  // rollup asserts on therefore has to be seeded here, in beforeAll, which
  // persists for the file.
  beforeAll(async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO projects (project_id, tenant_id, name) VALUES (?, ?, ?)",
    )
      .bind(P_PROJECT, TENANT, "Beta Launch")
      .run();

    // RM2,000 revenue and RM500 cost, both tagged to the same project.
    await postEntry(
      [
        { account_id: arId, amount_cents: 200_000, project_id: P_PROJECT },
        { account_id: revenueId, amount_cents: -200_000, project_id: P_PROJECT },
      ],
      "beta revenue",
    );
    await postEntry(
      [
        { account_id: expenseId, amount_cents: 50_000, project_id: P_PROJECT },
        { account_id: arId, amount_cents: -50_000, project_id: P_PROJECT },
      ],
      "beta cost",
    );
    // Untagged revenue — the Unallocated bucket's contents.
    await postEntry(
      [
        { account_id: arId, amount_cents: 1_500 },
        { account_id: revenueId, amount_cents: -1_500 },
      ],
      "untagged revenue",
    );
    // Customer-tagged revenue, via a real invoice so the derivation path is
    // what feeds the customer axis.
    await api("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER,
        currency: "MYR",
        due_date: "2026-08-10",
        lines: [{ description: "Consulting", quantity: 1, unit_cents: 100_000 }],
      }),
    });
    // Department-tagged cost.
    await postEntry(
      [
        { account_id: expenseId, amount_cents: 2_000, department_code: "finance" },
        { account_id: arId, amount_cents: -2_000 },
      ],
      "finance dept cost",
    );
  });

  it("returns revenue minus cost as margin for a tagged project", async () => {
    const body = (await (
      await api("/v1/insights/profitability?group_by=project", { headers: auth })
    ).json()) as {
      group_by: string;
      rows: {
        key: string | null;
        label: string;
        revenue_cents: number;
        cost_cents: number;
        margin_cents: number;
        margin_pct: number | null;
      }[];
    };

    expect(body.group_by).toBe("project");
    const beta = body.rows.find((r) => r.key === P_PROJECT)!;
    expect(beta.label).toBe("Beta Launch");
    expect(beta.revenue_cents).toBe(200_000);
    expect(beta.cost_cents).toBe(50_000);
    expect(beta.margin_cents).toBe(150_000);
    expect(beta.margin_pct).toBe(75);
  });

  it("puts untagged entries in an explicit Unallocated bucket rather than dropping them", async () => {
    const body = (await (
      await api("/v1/insights/profitability?group_by=project", { headers: auth })
    ).json()) as { rows: { key: string | null; label: string; revenue_cents: number }[] };

    const unallocated = body.rows.find((r) => r.key === null);
    expect(unallocated).toBeDefined();
    expect(unallocated!.label).toBe("Unallocated");
    // The no-dimension entry posted earlier in this file lands here.
    expect(unallocated!.revenue_cents).toBeGreaterThan(0);
    // Unallocated sorts last so it reads as a residual.
    expect(body.rows.at(-1)?.key).toBeNull();
  });

  it("groups by customer, resolving the customer name", async () => {
    const body = (await (
      await api("/v1/insights/profitability?group_by=customer", { headers: auth })
    ).json()) as { rows: { key: string | null; label: string; revenue_cents: number }[] };

    const acme = body.rows.find((r) => r.key === CUSTOMER)!;
    expect(acme.label).toBe("Acme Sdn Bhd");
    expect(acme.revenue_cents).toBe(100_000);
  });

  it("groups by department, resolving the registry label", async () => {
    const body = (await (
      await api("/v1/insights/profitability?group_by=department", { headers: auth })
    ).json()) as { rows: { key: string | null; label: string; cost_cents: number }[] };

    const finance = body.rows.find((r) => r.key === "finance")!;
    expect(finance.label).toBe("Finance");
    expect(finance.cost_cents).toBe(2_000);
  });

  it("rejects an unknown group_by", async () => {
    const res = await api("/v1/insights/profitability?group_by=nonsense", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("never returns another tenant's ledger", async () => {
    const otherKey = "test_api_key_ledger_dims_other";
    const otherTenant = "biz_ledger_dims_other";
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
    )
      .bind(otherTenant, "Other Tenant", await sha256Hex(otherKey))
      .run();

    const body = (await (
      await api("/v1/insights/profitability?group_by=project", {
        headers: { Authorization: `Bearer ${otherKey}` },
      })
    ).json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });
});
