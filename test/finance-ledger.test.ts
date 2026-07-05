import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import {
  ensureSystemAccounts,
  getAccountByCode,
  postEntry,
  reverseEntry,
} from "../src/modules/finance/ledger";

const API_KEY = "test_api_key_ledger";
const TENANT_ID = "biz_ledger";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function seedTenant() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Ledger Test SME", await sha256Hex(API_KEY))
    .run();
  await ensureSystemAccounts(env.DB, TENANT_ID);
}

function gatewayFetch(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  return worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
}

async function globalBalanceCheck(): Promise<{ entry_id: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT entry_id FROM journal_lines GROUP BY tenant_id, entry_id
     HAVING SUM(amount_cents) != 0`,
  ).all<{ entry_id: string }>();
  return results;
}

beforeAll(seedTenant);

describe("chart of accounts", () => {
  it("GET /v1/ledger/accounts seeds and returns the system chart", async () => {
    const res = await gatewayFetch("/v1/ledger/accounts", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: { code: string; is_system: boolean }[] };
    const codes = body.accounts.map((a) => a.code);
    expect(codes).toEqual(["1000", "1100", "2000", "3000", "4000", "5000"]);
    expect(body.accounts.every((a) => a.is_system)).toBe(true);
  });

  it("seeding is idempotent", async () => {
    await ensureSystemAccounts(env.DB, TENANT_ID);
    await ensureSystemAccounts(env.DB, TENANT_ID);
    const { results } = await env.DB.prepare(
      "SELECT code FROM accounts WHERE tenant_id = ?",
    )
      .bind(TENANT_ID)
      .all();
    expect(results).toHaveLength(6);
  });
});

describe("posting invariants", () => {
  it("rejects an unbalanced entry with 422 and writes nothing", async () => {
    const ar = await getAccountByCode(env.DB, TENANT_ID, "1100");
    const revenue = await getAccountByCode(env.DB, TENANT_ID, "4000");
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM journal_entries WHERE tenant_id = ?",
    )
      .bind(TENANT_ID)
      .first<{ n: number }>();

    const res = await gatewayFetch("/v1/ledger/entries", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        entry_date: "2026-07-01",
        currency: "MYR",
        lines: [
          { account_id: ar.account_id, amount_cents: 10_000 },
          { account_id: revenue.account_id, amount_cents: -9_999 },
        ],
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("unbalanced");

    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM journal_entries WHERE tenant_id = ?",
    )
      .bind(TENANT_ID)
      .first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("rejects entries with fewer than two lines (schema-level)", async () => {
    const ar = await getAccountByCode(env.DB, TENANT_ID, "1100");
    const res = await gatewayFetch("/v1/ledger/entries", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        entry_date: "2026-07-01",
        currency: "MYR",
        lines: [{ account_id: ar.account_id, amount_cents: 0 }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects entries referencing unknown accounts with 422", async () => {
    const ar = await getAccountByCode(env.DB, TENANT_ID, "1100");
    const res = await gatewayFetch("/v1/ledger/entries", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        entry_date: "2026-07-01",
        currency: "MYR",
        lines: [
          { account_id: ar.account_id, amount_cents: 500 },
          { account_id: "acct_does_not_exist", amount_cents: -500 },
        ],
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("unknown_account");
  });

  it("posts a balanced entry and reads it back with ordered lines", async () => {
    const cash = await getAccountByCode(env.DB, TENANT_ID, "1000");
    const equity = await getAccountByCode(env.DB, TENANT_ID, "3000");
    const post = await gatewayFetch("/v1/ledger/entries", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        entry_date: "2026-07-01",
        memo: "initial capital",
        currency: "MYR",
        lines: [
          { account_id: cash.account_id, amount_cents: 100_000 },
          { account_id: equity.account_id, amount_cents: -100_000 },
        ],
      }),
    });
    expect(post.status).toBe(201);
    const { entry_id } = (await post.json()) as { entry_id: string };
    expect(entry_id).toMatch(/^je_/);

    const get = await gatewayFetch(`/v1/ledger/entries/${entry_id}`, { headers: auth });
    expect(get.status).toBe(200);
    const entry = (await get.json()) as {
      source_type: string;
      lines: { line_no: number; amount_cents: number }[];
    };
    expect(entry.source_type).toBe("manual");
    expect(entry.lines.map((l) => l.line_no)).toEqual([1, 2]);
    expect(entry.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(0);
  });
});

describe("append-only enforcement", () => {
  it("UPDATE and DELETE on journal tables abort via trigger", async () => {
    const cash = await getAccountByCode(env.DB, TENANT_ID, "1000");
    const revenue = await getAccountByCode(env.DB, TENANT_ID, "4000");
    const { entry_id } = await postEntry(env.DB, TENANT_ID, {
      entry_date: "2026-07-02",
      currency: "MYR",
      source_type: "manual",
      lines: [
        { account_id: cash.account_id, amount_cents: 1_000 },
        { account_id: revenue.account_id, amount_cents: -1_000 },
      ],
    });

    await expect(
      env.DB.prepare("UPDATE journal_entries SET memo = 'tampered' WHERE entry_id = ?")
        .bind(entry_id)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM journal_entries WHERE entry_id = ?").bind(entry_id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE journal_lines SET amount_cents = 999 WHERE entry_id = ?")
        .bind(entry_id)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM journal_lines WHERE entry_id = ?").bind(entry_id).run(),
    ).rejects.toThrow(/append-only/);
  });
});

describe("balances and reversals", () => {
  it("reversal restores the account to its prior balance", async () => {
    const cash = await getAccountByCode(env.DB, TENANT_ID, "1000");
    const revenue = await getAccountByCode(env.DB, TENANT_ID, "4000");

    const balanceOf = async (accountId: string) => {
      const res = await gatewayFetch(`/v1/ledger/accounts/${accountId}/balance`, {
        headers: auth,
      });
      return ((await res.json()) as { balance_cents: number }).balance_cents;
    };

    const before = await balanceOf(cash.account_id);
    const { entry_id } = await postEntry(env.DB, TENANT_ID, {
      entry_date: "2026-07-03",
      currency: "MYR",
      source_type: "manual",
      lines: [
        { account_id: cash.account_id, amount_cents: 7_700 },
        { account_id: revenue.account_id, amount_cents: -7_700 },
      ],
    });
    expect(await balanceOf(cash.account_id)).toBe(before + 7_700);

    const reversal = await reverseEntry(env.DB, TENANT_ID, entry_id);
    expect(reversal).not.toBeNull();
    expect(await balanceOf(cash.account_id)).toBe(before);

    const get = await gatewayFetch(`/v1/ledger/entries/${reversal!.entry_id}`, { headers: auth });
    const entry = (await get.json()) as { source_type: string; reverses_entry_id: string };
    expect(entry.source_type).toBe("reversal");
    expect(entry.reverses_entry_id).toBe(entry_id);
  });

  it("balance of an unknown account is 404", async () => {
    const res = await gatewayFetch("/v1/ledger/accounts/acct_nope/balance", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("global invariant: no entry's lines sum to non-zero after a mixed op sequence", async () => {
    const cash = await getAccountByCode(env.DB, TENANT_ID, "1000");
    const ar = await getAccountByCode(env.DB, TENANT_ID, "1100");
    const revenue = await getAccountByCode(env.DB, TENANT_ID, "4000");
    const expenses = await getAccountByCode(env.DB, TENANT_ID, "5000");

    // A randomized-but-reproducible sequence of balanced entries and reversals.
    const amounts = [1_234, 56_789, 3, 999_999, 42_00];
    const posted: string[] = [];
    for (const [i, amount] of amounts.entries()) {
      const [debit, credit] =
        i % 2 === 0 ? [ar.account_id, revenue.account_id] : [expenses.account_id, cash.account_id];
      const { entry_id } = await postEntry(env.DB, TENANT_ID, {
        entry_date: "2026-07-04",
        currency: "MYR",
        source_type: "manual",
        lines: [
          { account_id: debit, amount_cents: amount },
          { account_id: credit, amount_cents: -amount },
        ],
      });
      posted.push(entry_id);
    }
    await reverseEntry(env.DB, TENANT_ID, posted[1]!);
    await reverseEntry(env.DB, TENANT_ID, posted[3]!);

    expect(await globalBalanceCheck()).toEqual([]);
  });
});
