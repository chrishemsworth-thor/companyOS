import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/** Phase C — GET /v1/ledger/entries list (feeds the new journal-entry UI + reverse action). */

const API_KEY = "test_api_key_ledger_list";
const TENANT = "biz_ledger_list";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function api(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let arId = "";
let revId = "";

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)")
    .bind(TENANT, "Ledger List", await sha256Hex(API_KEY))
    .run();
  // Seed the system chart and grab two account ids.
  const accounts = (await (await api("/v1/ledger/accounts", { headers: auth })).json()) as {
    accounts: { account_id: string; code: string }[];
  };
  arId = accounts.accounts.find((a) => a.code === "1100")!.account_id;
  revId = accounts.accounts.find((a) => a.code === "4000")!.account_id;

  for (const cents of [45_000, 12_500]) {
    const res = await api("/v1/ledger/entries", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        entry_date: "2026-07-05",
        currency: "MYR",
        memo: `manual ${cents}`,
        lines: [
          { account_id: arId, amount_cents: cents },
          { account_id: revId, amount_cents: -cents },
        ],
      }),
    });
    expect(res.status).toBe(201);
  }
});

describe("GET /v1/ledger/entries", () => {
  it("lists journal entry headers with a debit total", async () => {
    const body = (await (await api("/v1/ledger/entries", { headers: auth })).json()) as {
      entries: { entry_id: string; total_cents: number; source_type: string }[];
      next_cursor: string | null;
    };
    expect(body.entries.length).toBe(2);
    expect(body.entries.map((e) => e.total_cents).sort((a, b) => a - b)).toEqual([12_500, 45_000]);
    expect(body.entries.every((e) => e.source_type === "manual")).toBe(true);
  });

  it("paginates with a cursor", async () => {
    const first = (await (await api("/v1/ledger/entries?limit=1", { headers: auth })).json()) as {
      entries: { entry_id: string }[];
      next_cursor: string | null;
    };
    expect(first.entries.length).toBe(1);
    expect(first.next_cursor).not.toBeNull();
    const second = (await (
      await api(`/v1/ledger/entries?limit=1&cursor=${first.next_cursor}`, { headers: auth })
    ).json()) as { entries: { entry_id: string }[] };
    expect(second.entries.length).toBe(1);
    expect(second.entries[0]!.entry_id).not.toBe(first.entries[0]!.entry_id);
  });

  it("a listed entry can be reversed", async () => {
    const body = (await (await api("/v1/ledger/entries", { headers: auth })).json()) as {
      entries: { entry_id: string }[];
    };
    const target = body.entries[0]!.entry_id;
    const res = await api(`/v1/ledger/entries/${target}/reverse`, { method: "POST", headers: auth });
    expect(res.status).toBe(201);
    const reversal = (await res.json()) as { entry_id: string };
    const detail = (await (await api(`/v1/ledger/entries/${reversal.entry_id}`, { headers: auth })).json()) as {
      source_type: string;
      reverses_entry_id: string;
    };
    expect(detail.source_type).toBe("reversal");
    expect(detail.reverses_entry_id).toBe(target);
  });
});
