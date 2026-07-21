import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { encryptRefreshToken } from "../src/integrations/google/crypto";

/**
 * GmailReminderAdapter — the existing invoice-reminder flow routed through a
 * connected Gmail account when the tenant's email delivery_config names one.
 * No real HTTP: Google's token + send endpoints are stubbed.
 */

const API_KEY = "test_api_key_google_delivery";
const TENANT_ID = "biz_google_delivery";
const CUSTOMER_ID = "cust_gdlv";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function routeFetch(handlers: Record<string, () => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    for (const [needle, make] of Object.entries(handlers)) {
      if (url.includes(needle)) return make();
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return { mock, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function insertAccount(accountId: string, scopes: string, status = "active") {
  const sealed = await encryptRefreshToken(env.GOOGLE_TOKEN_ENCRYPTION_KEY!, "1//refresh");
  await env.DB.prepare(
    `INSERT INTO google_accounts (account_id, tenant_id, kind, google_email, scopes, refresh_token_ciphertext, refresh_token_iv, status)
     VALUES (?, ?, 'shared', ?, ?, ?, ?, ?)`,
  )
    .bind(accountId, TENANT_ID, "support@company.com", scopes, sealed.ciphertext, sealed.iv, status)
    .run();
}

async function enableEmail(googleAccountId: string | null) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO delivery_config (tenant_id, channel, from_address, enabled, google_account_id) VALUES (?, 'email', ?, 1, ?)",
  )
    .bind(TENANT_ID, "billing@company.com", googleAccountId)
    .run();
}

async function createInvoice(): Promise<string> {
  const res = await gatewayFetch("/v1/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: CUSTOMER_ID,
      currency: "MYR",
      due_date: "2026-06-26",
      lines: [{ description: "Consulting", quantity: 1, unit_cents: 120_000 }],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { invoice_id: string }).invoice_id;
}

async function lastDelivery(invoiceId: string) {
  return env.DB.prepare(
    "SELECT provider, to_address, status, delivery_ref FROM deliveries WHERE tenant_id = ? AND invoice_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(TENANT_ID, invoiceId)
    .first<{ provider: string; to_address: string; status: string; delivery_ref: string | null }>();
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Google Delivery SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Ada", "ada@external-corp.com", null, new Date().toISOString())
    .run();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.prepare("DELETE FROM delivery_config WHERE tenant_id = ?").bind(TENANT_ID).run();
  await env.DB.prepare("DELETE FROM google_accounts WHERE tenant_id = ?").bind(TENANT_ID).run();
});

describe("GmailReminderAdapter via sendReminder", () => {
  it("routes an invoice reminder through the connected Gmail account", async () => {
    await insertAccount("gac_dlv_active", "https://www.googleapis.com/auth/gmail.send");
    await enableEmail("gac_dlv_active");

    const { calls } = routeFetch({
      "oauth2.googleapis.com/token": () => json({ access_token: "ya29.dlv", expires_in: 3599, scope: "x" }),
      "gmail/v1/users/me/messages/send": () => json({ id: "gmail_msg_1", threadId: "thr_1" }),
    });

    const invoiceId = await createInvoice();
    const res = await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "email", message: "Please settle invoice." }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { provider: string; delivery_ref: string; channel: string };
    expect(body.provider).toBe("google");
    expect(body.delivery_ref).toBe("gmail_msg_1");

    // The message went out from the connected mailbox to the external customer.
    const sendCall = calls.find((c) => c.url.includes("messages/send"))!;
    const raw = (JSON.parse(sendCall.init!.body as string) as { raw: string }).raw;
    const mime = new TextDecoder().decode(
      Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)),
    );
    expect(mime).toContain("From: support@company.com");
    expect(mime).toContain("To: ada@external-corp.com");

    const row = await lastDelivery(invoiceId);
    expect(row).toMatchObject({ provider: "google", status: "sent", delivery_ref: "gmail_msg_1" });
  });

  it("falls back to console when the named account is revoked (no live send)", async () => {
    await insertAccount("gac_dlv_revoked", "https://www.googleapis.com/auth/gmail.send", "revoked");
    await enableEmail("gac_dlv_revoked");
    const { mock } = routeFetch({}); // any fetch would throw

    const invoiceId = await createInvoice();
    const res = await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "email" }),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { provider: string }).provider).toBe("console");
    expect(mock).not.toHaveBeenCalled(); // fell back before any HTTP
  });

  it("falls back when the account lacks the send scope", async () => {
    await insertAccount("gac_dlv_readonly", "https://www.googleapis.com/auth/gmail.readonly");
    await enableEmail("gac_dlv_readonly");
    routeFetch({});

    const invoiceId = await createInvoice();
    const res = await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "email" }),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { provider: string }).provider).toBe("console");
  });
});
