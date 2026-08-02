import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { setEventSenderForTests } from "../src/queue/producer";
import { addDays, resolvePaymentTermsDays } from "../src/modules/finance/payment-terms";

/**
 * PRD-003 (S8) P0 — customer commercial attributes, and the finance write path
 * they change.
 *
 * SESSION-PLAN conflict C7: `payment_terms_days` "is used to compute invoice
 * due dates automatically, which is the point of storing it. That is a change
 * to invoice creation, not to CRM." So half this file is a finance test.
 */

const API_KEY = "test_api_key_attrs";
const TENANT_ID = "biz_attrs";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

const C = {
  terms45: "cust_attrs_45",
  noTerms: "cust_attrs_default",
  termsZero: "cust_attrs_zero",
  limited: "cust_attrs_limited",
} as const;

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Attributes SME", await sha256Hex(API_KEY))
    .run();
  for (const id of Object.values(C)) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, TENANT_ID, `Customer ${id}`, new Date().toISOString())
      .run();
  }
  await env.DB.prepare(
    "UPDATE customers SET payment_terms_days = 45 WHERE tenant_id = ? AND customer_id = ?",
  )
    .bind(TENANT_ID, C.terms45)
    .run();
  await env.DB.prepare(
    "UPDATE customers SET payment_terms_days = 0 WHERE tenant_id = ? AND customer_id = ?",
  )
    .bind(TENANT_ID, C.termsZero)
    .run();
  await env.DB.prepare(
    "UPDATE customers SET credit_limit_cents = 500000 WHERE tenant_id = ? AND customer_id = ?",
  )
    .bind(TENANT_ID, C.limited)
    .run();
});

beforeEach(() => setEventSenderForTests(async () => {}));
afterEach(() => setEventSenderForTests(null));

async function createInvoice(body: Record<string, unknown>) {
  const res = await gatewayFetch("/v1/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      currency: "MYR",
      lines: [{ description: "Consulting", quantity: 1, unit_cents: 100_000 }],
      ...body,
    }),
  });
  return { status: res.status, body: (await res.json()) as { due_date: string; error?: string } };
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// AC: "Given a customer with 45-day terms, when an invoice is created without
//      an explicit due date, then due date is issue date + 45 days."
// ---------------------------------------------------------------------------

describe("acceptance: payment terms compute the invoice due date", () => {
  it("uses the customer's 45-day terms when no due_date is given", async () => {
    const { status, body } = await createInvoice({ customer_id: C.terms45 });
    expect(status).toBe(201);
    expect(body.due_date).toBe(addDays(today(), 45));
  });

  it("falls back to the tenant default when the customer has no terms", async () => {
    await gatewayFetch("/v1/settings/company-profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ legal_name: "Attributes SME", default_payment_terms_days: 14 }),
    });

    const { body } = await createInvoice({ customer_id: C.noTerms });
    expect(body.due_date).toBe(addDays(today(), 14));
  });

  it("falls back to 30 days when neither is set", async () => {
    // No company_profile row at all — the "no row means defaults" pattern the
    // rest of settings follows.
    const { body } = await createInvoice({ customer_id: C.noTerms });
    expect(body.due_date).toBe(addDays(today(), 30));
  });

  it("honours 0-day terms as due-on-issue, not as 'unset'", async () => {
    // The reason customers.payment_terms_days is nullable: NULL means "use the
    // default", 0 means "pay now". Collapsing them would be a silent 30-day
    // extension for a cash-on-delivery customer.
    const { body } = await createInvoice({ customer_id: C.termsZero });
    expect(body.due_date).toBe(today());
  });

  it("still lets an explicit due_date win over both", async () => {
    const { body } = await createInvoice({ customer_id: C.terms45, due_date: "2027-03-01" });
    expect(body.due_date).toBe("2027-03-01");
  });

  it("resolves terms per customer, not per tenant", async () => {
    expect(await resolvePaymentTermsDays(env.DB, TENANT_ID, C.terms45)).toBe(45);
    expect(await resolvePaymentTermsDays(env.DB, TENANT_ID, C.noTerms)).toBe(30);
    expect(await resolvePaymentTermsDays(env.DB, TENANT_ID, C.termsZero)).toBe(0);
  });

  it("crosses month and year boundaries correctly", async () => {
    expect(addDays("2026-01-20", 45)).toBe("2026-03-06");
    expect(addDays("2026-12-20", 45)).toBe("2027-02-03");
    // 2028 is a leap year — February has to have 29 days here.
    expect(addDays("2028-02-01", 29)).toBe("2028-03-01");
  });
});

// ---------------------------------------------------------------------------
// AC: "Given a customer with a credit limit, when a new invoice would exceed
//      outstanding AR + limit, then the console warns (warn only — do not
//      block)."
// ---------------------------------------------------------------------------

describe("acceptance: credit limit warns and never blocks", () => {
  async function detail(customerId: string) {
    const res = await gatewayFetch(`/v1/customers/${customerId}`, { headers: auth });
    return (await res.json()) as {
      credit: {
        limit_cents: number | null;
        outstanding_ar_cents: number;
        available_cents: number | null;
      };
    };
  }

  it("reports the limit and the outstanding AR the console compares against", async () => {
    const { body } = await createInvoice({ customer_id: C.limited, due_date: "2027-01-01" });
    expect(body.due_date).toBe("2027-01-01");
    await gatewayFetch("/v1/invoices", { headers: auth });

    const { credit } = await detail(C.limited);
    expect(credit.limit_cents).toBe(500_000);
    // Draft invoices count toward exposure — they are money the customer owes
    // as soon as it is sent, and warning only after sending is warning too late.
    expect(credit.outstanding_ar_cents).toBe(100_000);
    expect(credit.available_cents).toBe(400_000);
  });

  it("creates an invoice that blows straight through the limit — 201, not 4xx", async () => {
    const { status } = await createInvoice({
      customer_id: C.limited,
      due_date: "2027-01-01",
      lines: [{ description: "Huge", quantity: 1, unit_cents: 9_000_000 }],
    });
    expect(status).toBe(201);

    const { credit } = await detail(C.limited);
    expect(credit.outstanding_ar_cents).toBe(9_000_000);
    expect(credit.available_cents).toBeLessThan(0);
  });

  it("reports null rather than zero when no limit is set", async () => {
    // "No limit" and "a limit of zero" are different facts and the console
    // renders them differently.
    const { credit } = await detail(C.noTerms);
    expect(credit.limit_cents).toBeNull();
    expect(credit.available_cents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC: "Given structured addresses, then the rendered invoice and quote
//      documents use them."
// ---------------------------------------------------------------------------

describe("acceptance: commercial attributes round-trip", () => {
  it("accepts and returns every new attribute", async () => {
    const patch = {
      industry: "Manufacturing",
      website: "https://kilang.example",
      payment_terms_days: 60,
      credit_limit_cents: 2_500_000,
      preferred_channel: "whatsapp",
      notes: "Prefers a call before any invoice chase.",
      ship_address_line1: "Lot 12, Jalan Perusahaan",
      ship_city: "Shah Alam",
      ship_state: "Selangor",
      ship_postcode: "40150",
      ship_country: "Malaysia",
    };
    const res = await gatewayFetch(`/v1/customers/${C.noTerms}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(patch);
  });

  it("keeps SSM and SST on their existing columns rather than adding synonyms", async () => {
    // PRD-003 names these registration_no and tax_id; 0013 shipped reg_no and
    // tax_no and the quote "To" block already renders them. Two columns for one
    // fact is the thing this asserts against.
    const res = await gatewayFetch(`/v1/customers/${C.noTerms}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ reg_no: "202301012345", tax_no: "W10-1808-31000123" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reg_no).toBe("202301012345");
    expect(body.tax_no).toBe("W10-1808-31000123");
    expect(body).not.toHaveProperty("registration_no");
    expect(body).not.toHaveProperty("tax_id");
  });

  it("keeps billing and shipping addresses independent", async () => {
    await gatewayFetch(`/v1/customers/${C.noTerms}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        address_line1: "Level 8, Menara Billing",
        city: "Kuala Lumpur",
        ship_address_line1: "Lot 12, Jalan Gudang",
        ship_city: "Klang",
      }),
    });
    const res = await gatewayFetch(`/v1/customers/${C.noTerms}`, { headers: auth });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.address_line1).toBe("Level 8, Menara Billing");
    expect(body.city).toBe("Kuala Lumpur");
    expect(body.ship_address_line1).toBe("Lot 12, Jalan Gudang");
    expect(body.ship_city).toBe("Klang");
  });

  it("rejects a preferred_channel outside the delivery vocabulary", async () => {
    const res = await gatewayFetch(`/v1/customers/${C.noTerms}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ preferred_channel: "carrier_pigeon" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects nonsense payment terms", async () => {
    for (const value of [-1, 400, 1.5]) {
      const res = await gatewayFetch(`/v1/customers/${C.noTerms}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ payment_terms_days: value }),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("the tenant default is settable", () => {
  it("round-trips through the company profile", async () => {
    const put = await gatewayFetch("/v1/settings/company-profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ legal_name: "Attributes SME", default_payment_terms_days: 21 }),
    });
    expect(put.status).toBe(200);

    const res = await gatewayFetch("/v1/settings/company-profile", { headers: auth });
    const { company_profile } = (await res.json()) as {
      company_profile: { default_payment_terms_days: number };
    };
    expect(company_profile.default_payment_terms_days).toBe(21);
  });

  it("defaults to 30 when the profile is written without it", async () => {
    await gatewayFetch("/v1/settings/company-profile", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ legal_name: "Attributes SME" }),
    });
    const res = await gatewayFetch("/v1/settings/company-profile", { headers: auth });
    const { company_profile } = (await res.json()) as {
      company_profile: { default_payment_terms_days: number };
    };
    expect(company_profile.default_payment_terms_days).toBe(30);
  });
});
