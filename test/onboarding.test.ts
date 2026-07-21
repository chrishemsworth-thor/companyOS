import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";

/**
 * First-run onboarding + company base currency. Covers the onboarded_at
 * signal (surfaced on /login and /me, set by the admin-only complete
 * endpoint), base_currency on the company profile, and the "base currency is
 * the default, documents stay multi-currency" rule across invoices, deals,
 * and quotes.
 */

const API_KEY = "test_api_key_onboarding";
const TENANT_ID = "biz_onboarding";
const WORKSPACE = "onboarding-co";
const ORIGIN = "http://localhost:5173";

const bearer = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function login(email: string, password: string) {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace: WORKSPACE, email, password }),
  });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const body = (await res.json()) as {
    csrf_token: string;
    tenant: { tenant_id: string; name: string; onboarded_at: string | null };
  };
  return { res, cookie, csrf: body.csrf_token, tenant: body.tenant };
}

function sessionHeaders(cookie: string, csrf: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: cookie,
    Origin: ORIGIN,
    "X-CSRF-Token": csrf,
  };
}

async function createCustomer(name: string): Promise<string> {
  const res = await fetchWorker("/v1/customers", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({ name, email: "c@onboarding.test" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { customer_id: string };
  return body.customer_id;
}

async function putProfile(fields: Record<string, unknown>): Promise<Response> {
  return fetchWorker("/v1/settings/company-profile", {
    method: "PUT",
    headers: bearer,
    body: JSON.stringify({ legal_name: "Onboarding Sdn Bhd", ...fields }),
  });
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(TENANT_ID, "Onboarding Tenant", WORKSPACE, await sha256Hex(API_KEY))
    .run();
  await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: "admin@onboarding.test",
    password: "admin-password",
    role: "admin",
  });
  await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: "ro@onboarding.test",
    password: "readonly-password",
    role: "readonly",
  });
});

describe("onboarding state", () => {
  it("surfaces onboarded_at (null for a fresh company) on /login and /me", async () => {
    const { res, cookie, tenant } = await login("admin@onboarding.test", "admin-password");
    expect(res.status).toBe(200);
    expect(tenant.onboarded_at).toBeNull();

    const me = await fetchWorker("/v1/auth/me", { headers: { Cookie: cookie, Origin: ORIGIN } });
    const meBody = (await me.json()) as { tenant: { onboarded_at: string | null } };
    expect(meBody.tenant.onboarded_at).toBeNull();
  });

  it("forbids a non-admin from completing onboarding (403)", async () => {
    const { cookie, csrf } = await login("ro@onboarding.test", "readonly-password");
    const res = await fetchWorker("/v1/settings/onboarding/complete", {
      method: "POST",
      headers: sessionHeaders(cookie, csrf),
    });
    expect(res.status).toBe(403);
  });

  it("lets the admin complete onboarding, idempotently", async () => {
    const { cookie, csrf } = await login("admin@onboarding.test", "admin-password");
    const res = await fetchWorker("/v1/settings/onboarding/complete", {
      method: "POST",
      headers: sessionHeaders(cookie, csrf),
    });
    expect(res.status).toBe(200);
    const { onboarded_at } = (await res.json()) as { onboarded_at: string };
    expect(onboarded_at).toBeTruthy();

    // A second call keeps the original timestamp (one-way switch).
    const again = await fetchWorker("/v1/settings/onboarding/complete", {
      method: "POST",
      headers: sessionHeaders(cookie, csrf),
    });
    const againBody = (await again.json()) as { onboarded_at: string };
    expect(againBody.onboarded_at).toBe(onboarded_at);

    const me = await fetchWorker("/v1/auth/me", { headers: { Cookie: cookie, Origin: ORIGIN } });
    const meBody = (await me.json()) as { tenant: { onboarded_at: string | null } };
    expect(meBody.tenant.onboarded_at).toBe(onboarded_at);
  });
});

describe("company base currency", () => {
  it("defaults to MYR when the profile omits it and round-trips an explicit value", async () => {
    let res = await putProfile({});
    expect(res.status).toBe(200);
    let profile = (await res.json()) as { base_currency: string };
    expect(profile.base_currency).toBe("MYR");

    res = await putProfile({ base_currency: "usd" });
    profile = (await res.json()) as { base_currency: string };
    expect(profile.base_currency).toBe("USD"); // normalized to uppercase

    const get = await fetchWorker("/v1/settings/company-profile", { headers: bearer });
    const body = (await get.json()) as { company_profile: { base_currency: string } };
    expect(body.company_profile.base_currency).toBe("USD");
  });

  it("rejects a non-3-letter base currency", async () => {
    const res = await putProfile({ base_currency: "US" });
    expect(res.status).toBe(400);
    const numeric = await putProfile({ base_currency: "123" });
    expect(numeric.status).toBe(400);
  });

  it("defaults invoice currency to the base currency, still overridable per invoice", async () => {
    await putProfile({ base_currency: "USD" });
    const customerId = await createCustomer("Invoice Customer");

    const defaulted = await fetchWorker("/v1/invoices", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        customer_id: customerId,
        due_date: "2026-09-01",
        lines: [{ description: "Services", quantity: 1, unit_cents: 10_000 }],
      }),
    });
    expect(defaulted.status).toBe(201);
    expect(((await defaulted.json()) as { currency: string }).currency).toBe("USD");

    const explicit = await fetchWorker("/v1/invoices", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        customer_id: customerId,
        currency: "EUR",
        due_date: "2026-09-01",
        lines: [{ description: "Services", quantity: 1, unit_cents: 10_000 }],
      }),
    });
    expect(explicit.status).toBe(201);
    expect(((await explicit.json()) as { currency: string }).currency).toBe("EUR");
  });

  it("defaults deal currency to the base currency, still overridable per deal", async () => {
    await putProfile({ base_currency: "SGD" });
    const customerId = await createCustomer("Deal Customer");

    const defaulted = await fetchWorker("/v1/deals", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ customer_id: customerId, title: "Retainer", value_cents: 50_000 }),
    });
    expect(defaulted.status).toBe(201);
    expect(((await defaulted.json()) as { currency: string }).currency).toBe("SGD");

    const explicit = await fetchWorker("/v1/deals", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        customer_id: customerId,
        title: "Retainer",
        value_cents: 50_000,
        currency: "GBP",
      }),
    });
    expect(explicit.status).toBe(201);
    expect(((await explicit.json()) as { currency: string }).currency).toBe("GBP");
  });

  it("defaults quote currency to the base currency unless branding configures one", async () => {
    await putProfile({ base_currency: "AUD" });
    const customerId = await createCustomer("Quote Customer");
    const lines = [{ item_name: "Consulting", quantity: 1, unit_cents: 20_000 }];

    // No quote_branding row => the company base currency applies.
    const fromBase = await fetchWorker("/v1/quotes", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ customer_id: customerId, issue_date: "2026-07-21", lines }),
    });
    expect(fromBase.status).toBe(201);
    expect(((await fromBase.json()) as { currency: string }).currency).toBe("AUD");

    // An explicitly configured branding currency stays authoritative.
    const branding = await fetchWorker("/v1/settings/quote-branding", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ template_config: { currency: "THB" } }),
    });
    expect(branding.status).toBe(200);
    const fromBranding = await fetchWorker("/v1/quotes", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ customer_id: customerId, issue_date: "2026-07-21", lines }),
    });
    expect(fromBranding.status).toBe(201);
    expect(((await fromBranding.json()) as { currency: string }).currency).toBe("THB");
  });
});
