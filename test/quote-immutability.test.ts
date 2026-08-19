import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * PRD-004 Phase A — immutability.
 *
 * *"A quote cannot be edited after being sent. Changes require a new version.
 * If the document can change after signing, the signature is worthless — this
 * is the load-bearing requirement of the whole feature."*
 *
 * Everything the rest of PRD-004 builds rests on this file passing: a public
 * link, an acceptance hash and an archived artifact are all worthless if the
 * quote behind them can still move.
 */

const API_KEY = "test_api_key_qimm";
const TENANT_ID = "biz_qimm";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface QuoteResp {
  quote_id: string;
  quote_number: string;
  status: string;
  version: number;
  supersedes_quote_id: string | null;
  superseded_by_quote_id: string | null;
  subtotal_cents: number;
  grand_total_cents: number;
  notes: string | null;
  lines?: { line_no: number; item_name: string; line_total_cents: number }[];
}

let customerId: string;

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Immutability Test SME", await sha256Hex(API_KEY))
    .run();
  const res = await fetchWorker("/v1/customers", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Locked Co" }),
  });
  customerId = ((await res.json()) as { customer_id: string }).customer_id;
});

async function makeQuote(extra: Record<string, unknown> = {}): Promise<QuoteResp> {
  const res = await fetchWorker("/v1/quotes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: customerId,
      issue_date: "2026-07-16",
      lines: [{ item_name: "Consulting", quantity: 2, unit_cents: 50_000 }],
      ...extra,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as QuoteResp;
}

/** Move a quote straight to a status, bypassing the service's own guards. */
async function forceStatus(quoteId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE quotes SET status = ? WHERE tenant_id = ? AND quote_id = ?")
    .bind(status, TENANT_ID, quoteId)
    .run();
}

describe("editing a draft", () => {
  it("patches header fields and leaves the lines and totals alone", async () => {
    const quote = await makeQuote();
    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ notes: "Revised scope discussed on the call" }),
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as QuoteResp;
    expect(patched.notes).toBe("Revised scope discussed on the call");
    expect(patched.grand_total_cents).toBe(quote.grand_total_cents);
    expect(patched.lines).toHaveLength(1);
  });

  it("recomputes totals when the lines are replaced", async () => {
    const quote = await makeQuote();
    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        lines: [
          { item_name: "Consulting", quantity: 1, unit_cents: 30_000 },
          { item_name: "Training", quantity: 2, unit_cents: 10_000, discount_cents: 5_000 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as QuoteResp;
    // 30000 + (20000 - 5000) = 45000 subtotal; 6% SST = 2700; total 47700.
    expect(patched.subtotal_cents).toBe(45_000);
    expect(patched.grand_total_cents).toBe(47_700);
    expect(patched.lines).toHaveLength(2);
    expect(patched.lines?.map((l) => l.line_no)).toEqual([1, 2]);
  });

  it("recomputes totals when only the tax rate changes", async () => {
    const quote = await makeQuote();
    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ tax_rate_bps: 0 }),
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as QuoteResp;
    expect(patched.grand_total_cents).toBe(100_000);
  });

  it("rejects an empty patch and an empty line set", async () => {
    const quote = await makeQuote();
    const empty = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    const noLines = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ lines: [] }),
    });
    expect(noLines.status).toBe(400);
  });
});

describe("a quote past draft is frozen", () => {
  it("409s an edit to a sent quote and names the way forward", async () => {
    const quote = await makeQuote();
    expect((await fetchWorker(`/v1/quotes/${quote.quote_id}/send`, { method: "POST", headers: auth })).status).toBe(200);

    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ notes: "sneaking a change in" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("locked");
    expect(body.error).toContain("new version");

    // And nothing moved.
    const after = (await (await fetchWorker(`/v1/quotes/${quote.quote_id}`, { headers: auth })).json()) as QuoteResp;
    expect(after.notes).toBeNull();
  });

  it.each(["pending_approval", "accepted", "rejected", "expired", "converted"])(
    "409s an edit to a %s quote",
    async (status) => {
      const quote = await makeQuote();
      await forceStatus(quote.quote_id, status);
      const res = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ notes: "nope" }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("locked");
    },
  );

  it("409s a line replacement on a sent quote without touching the stored lines", async () => {
    const quote = await makeQuote();
    await fetchWorker(`/v1/quotes/${quote.quote_id}/send`, { method: "POST", headers: auth });
    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ lines: [{ item_name: "Cheaper", quantity: 1, unit_cents: 1 }] }),
    });
    expect(res.status).toBe(409);
    const { results } = await env.DB.prepare(
      "SELECT item_name FROM quote_lines WHERE tenant_id = ? AND quote_id = ?",
    )
      .bind(TENANT_ID, quote.quote_id)
      .all<{ item_name: string }>();
    expect(results.map((r) => r.item_name)).toEqual(["Consulting"]);
  });
});

describe("versioning is the way to change a locked quote", () => {
  it("creates a linked draft carrying the same lines", async () => {
    const v1 = await makeQuote({ notes: "original terms" });
    await fetchWorker(`/v1/quotes/${v1.quote_id}/send`, { method: "POST", headers: auth });

    const res = await fetchWorker(`/v1/quotes/${v1.quote_id}/version`, { method: "POST", headers: auth });
    expect(res.status).toBe(201);
    const v2 = (await res.json()) as QuoteResp;

    expect(v2.status).toBe("draft");
    expect(v2.version).toBe(2);
    expect(v2.supersedes_quote_id).toBe(v1.quote_id);
    expect(v2.quote_id).not.toBe(v1.quote_id);
    expect(v2.quote_number).not.toBe(v1.quote_number);
    expect(v2.grand_total_cents).toBe(v1.grand_total_cents);
    expect(v2.lines).toHaveLength(1);
    expect(v2.notes).toBe("original terms");

    // The superseded quote keeps its number, its status and its content — only
    // the back-pointer changes. Somebody may have been shown it.
    const reread = (await (await fetchWorker(`/v1/quotes/${v1.quote_id}`, { headers: auth })).json()) as QuoteResp;
    expect(reread.status).toBe("sent");
    expect(reread.quote_number).toBe(v1.quote_number);
    expect(reread.version).toBe(1);
    expect(reread.superseded_by_quote_id).toBe(v2.quote_id);
  });

  it("the new version is editable and the old one still is not", async () => {
    const v1 = await makeQuote();
    await fetchWorker(`/v1/quotes/${v1.quote_id}/send`, { method: "POST", headers: auth });
    const v2 = (await (
      await fetchWorker(`/v1/quotes/${v1.quote_id}/version`, { method: "POST", headers: auth })
    ).json()) as QuoteResp;

    const editNew = await fetchWorker(`/v1/quotes/${v2.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ lines: [{ item_name: "Renegotiated", quantity: 1, unit_cents: 80_000 }] }),
    });
    expect(editNew.status).toBe(200);
    expect(((await editNew.json()) as QuoteResp).subtotal_cents).toBe(80_000);

    const editOld = await fetchWorker(`/v1/quotes/${v1.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ notes: "no" }),
    });
    expect(editOld.status).toBe(409);
  });

  it("refuses to version a draft (it can just be edited) or an already-superseded quote", async () => {
    const draft = await makeQuote();
    const onDraft = await fetchWorker(`/v1/quotes/${draft.quote_id}/version`, { method: "POST", headers: auth });
    expect(onDraft.status).toBe(409);
    expect(((await onDraft.json()) as { code: string }).code).toBe("invalid_status");

    const sent = await makeQuote();
    await fetchWorker(`/v1/quotes/${sent.quote_id}/send`, { method: "POST", headers: auth });
    expect((await fetchWorker(`/v1/quotes/${sent.quote_id}/version`, { method: "POST", headers: auth })).status).toBe(201);
    const second = await fetchWorker(`/v1/quotes/${sent.quote_id}/version`, { method: "POST", headers: auth });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("already_superseded");
  });

  it("404s a patch or a version request for an unknown quote", async () => {
    expect(
      (
        await fetchWorker("/v1/quotes/quote_nope", {
          method: "PATCH",
          headers: auth,
          body: JSON.stringify({ notes: "x" }),
        })
      ).status,
    ).toBe(404);
    expect((await fetchWorker("/v1/quotes/quote_nope/version", { method: "POST", headers: auth })).status).toBe(404);
  });
});

describe("lifecycle acts are single-shot", () => {
  it("409s a second send, a second accept and a second reject", async () => {
    const quote = await makeQuote();
    expect((await fetchWorker(`/v1/quotes/${quote.quote_id}/send`, { method: "POST", headers: auth })).status).toBe(200);
    expect((await fetchWorker(`/v1/quotes/${quote.quote_id}/send`, { method: "POST", headers: auth })).status).toBe(409);

    expect((await fetchWorker(`/v1/quotes/${quote.quote_id}/accept`, { method: "POST", headers: auth })).status).toBe(200);
    const twice = await fetchWorker(`/v1/quotes/${quote.quote_id}/accept`, { method: "POST", headers: auth });
    expect(twice.status).toBe(409);
    expect((await fetchWorker(`/v1/quotes/${quote.quote_id}/reject`, { method: "POST", headers: auth })).status).toBe(409);
  });

  it("refuses to accept an expired quote", async () => {
    const quote = await makeQuote();
    await fetchWorker(`/v1/quotes/${quote.quote_id}/send`, { method: "POST", headers: auth });
    await forceStatus(quote.quote_id, "expired");
    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}/accept`, { method: "POST", headers: auth });
    expect(res.status).toBe(409);
  });

  it("refuses to send a quote that is awaiting internal sign-off", async () => {
    const quote = await makeQuote();
    await forceStatus(quote.quote_id, "pending_approval");
    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}/send`, { method: "POST", headers: auth });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("pending_approval");
  });
});
