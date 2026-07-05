import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { getAccountByCode } from "../src/modules/finance/ledger";

const API_KEY = "test_api_key_finance";
const TENANT_ID = "biz_finance";
const CUSTOMER_ID = "cust_fin_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function seedTenant() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Finance Test SME", await sha256Hex(API_KEY))
    .run();
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createInvoice(unitCents: number): Promise<{ invoice_id: string }> {
  const res = await gatewayFetch("/v1/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: CUSTOMER_ID,
      currency: "MYR",
      due_date: "2026-08-01",
      lines: [{ description: "Widgets", quantity: 1, unit_cents: unitCents }],
    }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function sendInvoice(invoiceId: string): Promise<void> {
  const res = await gatewayFetch(`/v1/invoices/${invoiceId}/send`, {
    method: "POST",
    headers: auth,
  });
  expect(res.status).toBe(200);
}

async function balanceOfCode(code: "1000" | "1100" | "4000"): Promise<number> {
  const account = await getAccountByCode(env.DB, TENANT_ID, code);
  const res = await gatewayFetch(`/v1/ledger/accounts/${account.account_id}/balance`, {
    headers: auth,
  });
  return ((await res.json()) as { balance_cents: number }).balance_cents;
}

beforeAll(seedTenant);

describe("invoice lifecycle", () => {
  it("issuing an invoice posts Dr AR / Cr Revenue", async () => {
    const arBefore = (await balanceOfCode("1100").catch(() => 0)) || 0;
    const { invoice_id } = await createInvoice(10_000);

    expect(await balanceOfCode("1100")).toBe(arBefore + 10_000);

    const entry = await env.DB.prepare(
      "SELECT entry_id FROM journal_entries WHERE tenant_id = ? AND source_type = 'invoice' AND source_id = ?",
    )
      .bind(TENANT_ID, invoice_id)
      .first<{ entry_id: string }>();
    expect(entry).not.toBeNull();
  });

  it("send transitions draft → sent; resending is 409", async () => {
    const { invoice_id } = await createInvoice(5_000);
    await sendInvoice(invoice_id);

    const get = await gatewayFetch(`/v1/invoices/${invoice_id}`, { headers: auth });
    expect(((await get.json()) as { status: string }).status).toBe("sent");

    const again = await gatewayFetch(`/v1/invoices/${invoice_id}/send`, {
      method: "POST",
      headers: auth,
    });
    expect(again.status).toBe(409);
  });

  it("rejects zero-total invoices with 422", async () => {
    const res = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        currency: "MYR",
        due_date: "2026-08-01",
        lines: [{ description: "Freebie", quantity: 1, unit_cents: 0 }],
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_total");
  });
});

describe("payments", () => {
  it("full payment settles the invoice and posts Dr Cash / Cr AR", async () => {
    const { invoice_id } = await createInvoice(20_000);
    await sendInvoice(invoice_id);

    const cashBefore = await balanceOfCode("1000");
    const arBefore = await balanceOfCode("1100");

    const res = await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        amount_cents: 20_000,
        currency: "MYR",
        applications: [{ invoice_id, applied_cents: 20_000 }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payment_id: string; entry_id: string };
    expect(body.payment_id).toMatch(/^pay_/);
    expect(body.entry_id).toMatch(/^je_/);

    const invoice = (await (
      await gatewayFetch(`/v1/invoices/${invoice_id}`, { headers: auth })
    ).json()) as { status: string; amount_due_cents: number; paid_at: string };
    expect(invoice.status).toBe("paid");
    expect(invoice.amount_due_cents).toBe(0);
    expect(invoice.paid_at).not.toBeNull();

    expect(await balanceOfCode("1000")).toBe(cashBefore + 20_000);
    expect(await balanceOfCode("1100")).toBe(arBefore - 20_000);
  });

  it("partial payment leaves the correct remainder", async () => {
    const { invoice_id } = await createInvoice(30_000);
    await sendInvoice(invoice_id);

    const res = await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        amount_cents: 12_000,
        currency: "MYR",
        applications: [{ invoice_id, applied_cents: 12_000 }],
      }),
    });
    expect(res.status).toBe(201);

    const invoice = (await (
      await gatewayFetch(`/v1/invoices/${invoice_id}`, { headers: auth })
    ).json()) as { status: string; amount_due_cents: number };
    expect(invoice.status).toBe("partially_paid");
    expect(invoice.amount_due_cents).toBe(18_000);
  });

  it("rejects overpayment with 422 and writes nothing", async () => {
    const { invoice_id } = await createInvoice(1_000);
    await sendInvoice(invoice_id);

    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ?",
    )
      .bind(TENANT_ID)
      .first<{ n: number }>();

    const res = await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        amount_cents: 2_000,
        currency: "MYR",
        applications: [{ invoice_id, applied_cents: 2_000 }],
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("overpayment");

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ?")
      .bind(TENANT_ID)
      .first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("rejects applications that do not sum to the payment amount", async () => {
    const { invoice_id } = await createInvoice(4_000);
    await sendInvoice(invoice_id);

    const res = await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        amount_cents: 4_000,
        currency: "MYR",
        applications: [{ invoice_id, applied_cents: 3_000 }],
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("amount_mismatch");
  });

  it("rejects paying a draft invoice with 409", async () => {
    const { invoice_id } = await createInvoice(4_000);
    const res = await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        amount_cents: 4_000,
        currency: "MYR",
        applications: [{ invoice_id, applied_cents: 4_000 }],
      }),
    });
    expect(res.status).toBe(409);
  });

  it("one payment can settle several invoices", async () => {
    const a = await createInvoice(6_000);
    const b = await createInvoice(9_000);
    await sendInvoice(a.invoice_id);
    await sendInvoice(b.invoice_id);

    const res = await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        amount_cents: 15_000,
        currency: "MYR",
        applications: [
          { invoice_id: a.invoice_id, applied_cents: 6_000 },
          { invoice_id: b.invoice_id, applied_cents: 9_000 },
        ],
      }),
    });
    expect(res.status).toBe(201);

    for (const id of [a.invoice_id, b.invoice_id]) {
      const invoice = (await (
        await gatewayFetch(`/v1/invoices/${id}`, { headers: auth })
      ).json()) as { status: string };
      expect(invoice.status).toBe("paid");
    }
  });
});
