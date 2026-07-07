import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * Workstream 4 — `Idempotency-Key` on POST /v1/invoices and /v1/payments.
 * A retry with the same key must never double-write; a reused key with a
 * different body is a conflict, not a silent overwrite.
 */

const API_KEY = "test_api_key_idem";
const TENANT_ID = "biz_idem";
const CUSTOMER_ID = "cust_idem_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Idempotency Test SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Idem Customer", new Date().toISOString())
    .run();
}

beforeAll(seed);

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function invoiceBody(overrides: Record<string, unknown> = {}) {
  return {
    customer_id: CUSTOMER_ID,
    currency: "MYR",
    due_date: "2026-06-26",
    lines: [{ description: "Consulting", quantity: 1, unit_cents: 100_000 }],
    ...overrides,
  };
}

async function countInvoices(customerId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM invoices WHERE tenant_id = ? AND customer_id = ?",
  )
    .bind(TENANT_ID, customerId)
    .first<{ n: number }>();
  return row!.n;
}

describe("POST /v1/invoices idempotency", () => {
  it("retry with the same key and body replays the original response, no second invoice", async () => {
    const key = "idem-key-1";
    const before = await countInvoices(CUSTOMER_ID);

    const first = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify(invoiceBody()),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { invoice_id: string };

    const second = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify(invoiceBody()),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { invoice_id: string };

    expect(secondBody.invoice_id).toBe(firstBody.invoice_id);
    expect(await countInvoices(CUSTOMER_ID)).toBe(before + 1);
  });

  it("same key, different body → 422 key_reused, nothing written", async () => {
    const key = "idem-key-2";
    const before = await countInvoices(CUSTOMER_ID);

    const first = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify(invoiceBody({ due_date: "2026-06-26" })),
    });
    expect(first.status).toBe(201);

    const conflict = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify(invoiceBody({ due_date: "2026-07-01" })),
    });
    expect(conflict.status).toBe(422);
    expect(((await conflict.json()) as { code: string }).code).toBe("key_reused");
    expect(await countInvoices(CUSTOMER_ID)).toBe(before + 1);
  });

  it("no Idempotency-Key header → no dedup, each request writes", async () => {
    const before = await countInvoices(CUSTOMER_ID);
    await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(invoiceBody()),
    });
    await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(invoiceBody()),
    });
    expect(await countInvoices(CUSTOMER_ID)).toBe(before + 2);
  });

  it("replays cached business errors too (e.g. invalid_total) without re-running the write", async () => {
    const key = "idem-key-invalid";
    const badBody = invoiceBody({
      lines: [{ description: "Free", quantity: 1, unit_cents: 0 }],
    });

    const first = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify(badBody),
    });
    expect(first.status).toBe(422);
    expect(((await first.json()) as { code: string }).code).toBe("invalid_total");

    const second = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify(badBody),
    });
    expect(second.status).toBe(422);
    expect(((await second.json()) as { code: string }).code).toBe("invalid_total");
  });

  it("a still-in-flight claim (simulated) rejects a concurrent retry with 409", async () => {
    const key = "idem-key-inflight";
    // Simulate a request that claimed the key but hasn't finished yet.
    const requestHash = await sha256Hex(JSON.stringify(invoiceBody()));
    await env.DB.prepare(
      `INSERT INTO idempotency_keys (tenant_id, endpoint, idempotency_key, request_hash)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(TENANT_ID, "invoices.create", key, requestHash)
      .run();

    const res = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify(invoiceBody()),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("in_progress");
  });
});

describe("POST /v1/payments idempotency", () => {
  it("retry with the same key does not double-record the payment", async () => {
    const create = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(invoiceBody()),
    });
    const { invoice_id } = (await create.json()) as { invoice_id: string };
    await gatewayFetch(`/v1/invoices/${invoice_id}/send`, { method: "POST", headers: auth });

    const key = "idem-payment-1";
    const paymentBody = {
      customer_id: CUSTOMER_ID,
      amount_cents: 100_000,
      currency: "MYR",
      applications: [{ invoice_id, applied_cents: 100_000 }],
    };

    const first = await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify(paymentBody),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { payment_id: string };

    const second = await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify(paymentBody),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { payment_id: string };
    expect(secondBody.payment_id).toBe(firstBody.payment_id);

    // A second real settlement would overpay — the retry must have taken
    // the replay path, not run recordPayment again.
    const count = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM payments WHERE tenant_id = ? AND customer_id = ?",
    )
      .bind(TENANT_ID, CUSTOMER_ID)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });
});
