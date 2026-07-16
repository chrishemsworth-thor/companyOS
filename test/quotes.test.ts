import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

const API_KEY = "test_api_key_quotes";
const TENANT_ID = "biz_quotes";
const OTHER_API_KEY = "test_api_key_quotes_other";
const OTHER_TENANT_ID = "biz_quotes_other";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const otherAuth = { Authorization: `Bearer ${OTHER_API_KEY}`, "Content-Type": "application/json" };

async function seedTenants() {
  await env.DB.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)")
    .bind(TENANT_ID, "Quotes Test SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)")
    .bind(OTHER_TENANT_ID, "Other SME", await sha256Hex(OTHER_API_KEY))
    .run();
}

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createCustomer(headers = auth, body: Record<string, unknown> = { name: "Acme Sdn Bhd" }) {
  const res = await fetchWorker("/v1/customers", { method: "POST", headers, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return (await res.json()) as { customer_id: string };
}

interface QuoteResp {
  quote_id: string;
  quote_number: string;
  status: string;
  subtotal_cents: number;
  discount_total_cents: number;
  tax_rate_bps: number;
  tax_cents: number;
  grand_total_cents: number;
  converted_invoice_id: string | null;
}

async function createQuote(lines: unknown[], extra: Record<string, unknown> = {}, headers = auth) {
  const res = await fetchWorker("/v1/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify({ issue_date: "2026-07-16", lines, ...extra }),
  });
  return res;
}

beforeAll(seedTenants);

describe("quote totals + tax", () => {
  it("computes subtotal, discount and single-rounded 6% tax (default branding)", async () => {
    const { customer_id } = await createCustomer();
    const res = await createQuote([
      { item_name: "Setup", quantity: 1, unit_cents: 12_345 },
    ], { customer_id });
    expect(res.status).toBe(201);
    const q = (await res.json()) as QuoteResp;
    expect(q.quote_number).toMatch(/^Q2026-\d{4}$/);
    expect(q.status).toBe("draft");
    expect(q.subtotal_cents).toBe(12_345);
    expect(q.tax_rate_bps).toBe(600);
    // round(12345 * 600 / 10000) = round(740.7) = 741
    expect(q.tax_cents).toBe(741);
    expect(q.grand_total_cents).toBe(13_086);
  });

  it("rounds tax once on the header, not per line (no cents drift)", async () => {
    const { customer_id } = await createCustomer();
    // Two lines of 5c each: per-line tax would round to 0+0; header tax on 10c rounds to 1c.
    const res = await createQuote([
      { item_name: "A", quantity: 1, unit_cents: 5 },
      { item_name: "B", quantity: 1, unit_cents: 5 },
    ], { customer_id });
    const q = (await res.json()) as QuoteResp;
    expect(q.subtotal_cents).toBe(10);
    expect(q.tax_cents).toBe(1);
    expect(q.grand_total_cents).toBe(11);
  });

  it("applies per-line discounts and rejects a discount larger than the line", async () => {
    const { customer_id } = await createCustomer();
    const ok = await createQuote([
      { item_name: "Widget", quantity: 2, unit_cents: 10_000, discount_cents: 2_500 },
    ], { customer_id });
    const q = (await ok.json()) as QuoteResp;
    expect(q.subtotal_cents).toBe(17_500); // 2*10000 - 2500
    expect(q.discount_total_cents).toBe(2_500);

    const bad = await createQuote([
      { item_name: "Widget", quantity: 1, unit_cents: 100, discount_cents: 200 },
    ], { customer_id });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { code: string }).code).toBe("invalid_total");
  });

  it("rejects a quote with no lines", async () => {
    const { customer_id } = await createCustomer();
    const res = await fetchWorker("/v1/quotes", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ customer_id, lines: [] }),
    });
    expect(res.status).toBe(400); // zod min(1)
  });
});

describe("quote lifecycle + conversion", () => {
  async function draftQuote() {
    const { customer_id } = await createCustomer();
    const res = await createQuote([{ item_name: "Service", quantity: 1, unit_cents: 100_000 }], { customer_id });
    return (await res.json()) as QuoteResp;
  }

  it("guards transitions: send only from draft, accept/reject only from sent, convert only from accepted", async () => {
    const q = await draftQuote();

    // Can't accept a draft.
    let res = await fetchWorker(`/v1/quotes/${q.quote_id}/accept`, { method: "POST", headers: auth });
    expect(res.status).toBe(409);
    // Can't convert a draft.
    res = await fetchWorker(`/v1/quotes/${q.quote_id}/convert`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);

    // Send.
    res = await fetchWorker(`/v1/quotes/${q.quote_id}/send`, { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as QuoteResp).status).toBe("sent");
    // Can't send twice.
    res = await fetchWorker(`/v1/quotes/${q.quote_id}/send`, { method: "POST", headers: auth });
    expect(res.status).toBe(409);
  });

  it("accept → convert creates an invoice whose total equals the quote grand total exactly", async () => {
    const q = await draftQuote();
    await fetchWorker(`/v1/quotes/${q.quote_id}/send`, { method: "POST", headers: auth });
    const acc = await fetchWorker(`/v1/quotes/${q.quote_id}/accept`, { method: "POST", headers: auth });
    expect(acc.status).toBe(200);

    const conv = await fetchWorker(`/v1/quotes/${q.quote_id}/convert`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ due_date: "2026-09-01" }),
    });
    expect(conv.status).toBe(201);
    const { quote, invoice_id } = (await conv.json()) as { quote: QuoteResp; invoice_id: string };
    expect(quote.status).toBe("converted");
    expect(quote.converted_invoice_id).toBe(invoice_id);
    expect(invoice_id).toMatch(/^inv_/);

    const inv = await fetchWorker(`/v1/invoices/${invoice_id}`, { headers: auth });
    expect(inv.status).toBe(200);
    const invoice = (await inv.json()) as { total_cents: number; currency: string };
    expect(invoice.total_cents).toBe(q.grand_total_cents);

    // Converting again is rejected (already converted).
    const again = await fetchWorker(`/v1/quotes/${q.quote_id}/convert`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(409);
  });
});

describe("quote document (per-company branding)", () => {
  it("renders branded HTML and honours field/section toggles", async () => {
    // Seller identity + branding.
    await fetchWorker("/v1/settings/company-profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ legal_name: "Dapat Vista (M) Sdn Bhd", phone: "03-2779 0023" }),
    });
    const { customer_id } = await createCustomer(auth, {
      name: "Majlis Test",
      legal_name: "Majlis Bandaraya Test",
      address_line1: "Jalan Kolam Air",
    });
    const contactRes = await fetchWorker(`/v1/customers/${customer_id}/contacts`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Encik Ahmad", title: "IT Officer", is_primary: true }),
    });
    expect(contactRes.status).toBe(201);
    const contact = (await contactRes.json()) as { contact_id: string };

    const res = await createQuote(
      [{ item_name: "SMS Blast", quantity: 1, unit_cents: 150_000, discount_cents: 5_000 }],
      { customer_id, contact_id: contact.contact_id },
    );
    const q = (await res.json()) as QuoteResp;

    // Default branding: discount column + SST tax visible, brand colour in <style>.
    let doc = await fetchWorker(`/v1/quotes/${q.quote_id}/document`, { headers: auth });
    expect(doc.status).toBe(200);
    expect(doc.headers.get("content-type") ?? "").toContain("text/html");
    let html = await doc.text();
    expect(html).toContain("Dapat Vista (M) Sdn Bhd");
    expect(html).toContain("Majlis Bandaraya Test");
    expect(html).toContain("Encik Ahmad");
    expect(html).toContain(q.quote_number);
    expect(html).toContain("#1a1a2e"); // default primary colour
    expect(html).toContain("Discount");
    expect(html).toContain("SST 6%");

    // Reconfigure branding: hide discount + tax, change colour.
    await fetchWorker("/v1/settings/quote-branding", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        primary_color: "#ff0000",
        template_config: { show_discount_column: false, show_tax_line: false },
      }),
    });
    doc = await fetchWorker(`/v1/quotes/${q.quote_id}/document`, { headers: auth });
    html = await doc.text();
    expect(html).toContain("#ff0000");
    expect(html).not.toContain("Discount");
    expect(html).not.toContain("SST 6%");
  });

  it("rejects an invalid template_config", async () => {
    const res = await fetchWorker("/v1/settings/quote-branding", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ template_config: { number_format: "not-a-format" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("multi-tenant isolation + numbering", () => {
  it("hides one tenant's quotes from another and numbers per tenant", async () => {
    const a = await createCustomer(auth, { name: "Tenant A Co" });
    const aQuote = (await (await createQuote(
      [{ item_name: "X", quantity: 1, unit_cents: 1_000 }],
      { customer_id: a.customer_id },
      auth,
    )).json()) as QuoteResp;

    // Other tenant cannot read tenant A's quote.
    const cross = await fetchWorker(`/v1/quotes/${aQuote.quote_id}`, { headers: otherAuth });
    expect(cross.status).toBe(404);

    // Other tenant's first quote starts its own sequence at 0001.
    const b = await createCustomer(otherAuth, { name: "Tenant B Co" });
    const bQuote = (await (await createQuote(
      [{ item_name: "Y", quantity: 1, unit_cents: 1_000 }],
      { customer_id: b.customer_id },
      otherAuth,
    )).json()) as QuoteResp;
    expect(bQuote.quote_number).toBe("Q2026-0001");
  });
});
