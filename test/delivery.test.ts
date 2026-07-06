import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * Workstream 1 — real delivery providers behind the DeliveryProvider port.
 * Real HTTP is never made: provider requests are asserted against a stubbed
 * global fetch, and the console fallback covers the no-secret/no-config paths.
 */

const API_KEY = "test_api_key_delivery";
const TENANT_ID = "biz_delivery";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

const CUSTOMERS = {
  email_only: { id: "cust_dlv_email", email: "ada@example.com", phone: null },
  phone_only: { id: "cust_dlv_phone", email: null, phone: "+60123456789" },
  no_address: { id: "cust_dlv_none", email: null, phone: null },
} as const;

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Delivery Test SME", await sha256Hex(API_KEY))
    .run();
  for (const c of Object.values(CUSTOMERS)) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(c.id, TENANT_ID, `Customer ${c.id}`, c.email, c.phone, new Date().toISOString())
      .run();
  }
}

beforeAll(seed);

afterEach(async () => {
  vi.unstubAllGlobals();
  delete env.RESEND_API_KEY;
  delete env.TWILIO_ACCOUNT_SID;
  delete env.TWILIO_AUTH_TOKEN;
  await env.DB.prepare("DELETE FROM delivery_config WHERE tenant_id = ?").bind(TENANT_ID).run();
});

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createInvoice(customerId: string): Promise<string> {
  const res = await gatewayFetch("/v1/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: customerId,
      currency: "MYR",
      due_date: "2026-06-26",
      lines: [{ description: "Consulting", quantity: 1, unit_cents: 120_000 }],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { invoice_id: string }).invoice_id;
}

async function postReminder(invoiceId: string, body: Record<string, unknown> = {}) {
  return gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
}

async function enableChannel(channel: "email" | "whatsapp", fromAddress: string) {
  await env.DB.prepare(
    "INSERT INTO delivery_config (tenant_id, channel, from_address, enabled) VALUES (?, ?, ?, 1)",
  )
    .bind(TENANT_ID, channel, fromAddress)
    .run();
}

async function lastDelivery(invoiceId: string) {
  return env.DB.prepare(
    "SELECT channel, provider, to_address, status, delivery_ref FROM deliveries WHERE tenant_id = ? AND invoice_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(TENANT_ID, invoiceId)
    .first<{
      channel: string;
      provider: string;
      to_address: string;
      status: string;
      delivery_ref: string | null;
    }>();
}

function stubFetchOnce(response: Response) {
  const mock = vi.fn(async () => response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("console fallback", () => {
  it("no secrets, no config → console delivery, logged", async () => {
    const invoiceId = await createInvoice(CUSTOMERS.email_only.id);
    const res = await postReminder(invoiceId);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { delivery_ref: string; channel: string; provider: string };
    expect(body.provider).toBe("console");
    expect(body.channel).toBe("email");
    expect(body.delivery_ref).toMatch(/^dlv_/);

    const row = await lastDelivery(invoiceId);
    expect(row).toMatchObject({
      channel: "email",
      provider: "console",
      to_address: CUSTOMERS.email_only.email,
      status: "sent",
    });
  });

  it("secret configured but tenant not opted in → still console, no HTTP", async () => {
    env.RESEND_API_KEY = "re_test_key";
    const mock = stubFetchOnce(new Response("{}"));

    const invoiceId = await createInvoice(CUSTOMERS.email_only.id);
    const res = await postReminder(invoiceId);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { provider: string }).provider).toBe("console");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("resend (email)", () => {
  it("secret + enabled config → real request shape, provider ref logged", async () => {
    env.RESEND_API_KEY = "re_test_key";
    await enableChannel("email", "billing@sme.example");
    const mock = stubFetchOnce(
      new Response(JSON.stringify({ id: "re_msg_123" }), { status: 200 }),
    );

    const invoiceId = await createInvoice(CUSTOMERS.email_only.id);
    const res = await postReminder(invoiceId, { channel: "email", message: "Please pay up." });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { delivery_ref: string; provider: string };
    expect(body.provider).toBe("resend");
    expect(body.delivery_ref).toBe("re_msg_123");

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.from).toBe("billing@sme.example");
    expect(sent.to).toEqual([CUSTOMERS.email_only.email]);
    expect(sent.text).toBe("Please pay up.");
    expect(sent.subject).toContain(invoiceId);

    const row = await lastDelivery(invoiceId);
    expect(row).toMatchObject({ provider: "resend", status: "sent", delivery_ref: "re_msg_123" });
  });

  it("provider HTTP failure → 502 and a failed deliveries row", async () => {
    env.RESEND_API_KEY = "re_test_key";
    await enableChannel("email", "billing@sme.example");
    stubFetchOnce(new Response("boom", { status: 500 }));

    const invoiceId = await createInvoice(CUSTOMERS.email_only.id);
    const res = await postReminder(invoiceId);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("send_failed");

    const row = await lastDelivery(invoiceId);
    expect(row).toMatchObject({ provider: "resend", status: "failed", delivery_ref: null });
  });
});

describe("twilio (whatsapp)", () => {
  it("secrets + enabled config → Messages API request shape, sid logged", async () => {
    env.TWILIO_ACCOUNT_SID = "AC_test_sid";
    env.TWILIO_AUTH_TOKEN = "tok_test";
    await enableChannel("whatsapp", "+15550001111");
    const mock = stubFetchOnce(new Response(JSON.stringify({ sid: "SM_msg_456" }), { status: 201 }));

    const invoiceId = await createInvoice(CUSTOMERS.phone_only.id);
    const res = await postReminder(invoiceId, { channel: "whatsapp", message: "Gentle nudge." });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { delivery_ref: string; provider: string };
    expect(body.provider).toBe("twilio");
    expect(body.delivery_ref).toBe("SM_msg_456");

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_test_sid/Messages.json");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("AC_test_sid:tok_test")}`,
    );
    const params = new URLSearchParams(init.body as string);
    expect(params.get("From")).toBe("whatsapp:+15550001111");
    expect(params.get("To")).toBe(`whatsapp:${CUSTOMERS.phone_only.phone}`);
    expect(params.get("Body")).toBe("Gentle nudge.");

    const row = await lastDelivery(invoiceId);
    expect(row).toMatchObject({
      channel: "whatsapp",
      provider: "twilio",
      to_address: CUSTOMERS.phone_only.phone,
      status: "sent",
    });
  });
});

describe("recipient resolution", () => {
  it("falls back to the other channel when the requested one has no address", async () => {
    const invoiceId = await createInvoice(CUSTOMERS.phone_only.id);
    const res = await postReminder(invoiceId, { channel: "email" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { channel: string; provider: string };
    expect(body.channel).toBe("whatsapp");
    expect(body.provider).toBe("console");
  });

  it("422 when the customer has no address on either channel", async () => {
    const invoiceId = await createInvoice(CUSTOMERS.no_address.id);
    const res = await postReminder(invoiceId);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("no_recipient");
  });
});
