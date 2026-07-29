import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/** Gateway auth + native finance routes (folded in from the retired webhook-era vertical slice). */

const API_KEY = "test_api_key_biz_abc123";
const TENANT_ID = "biz_abc123";

async function seedTenant() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Test SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("cust_456", TENANT_ID, "Test Customer", "customer@example.com", new Date().toISOString())
    .run();
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(seedTenant);

describe("gateway auth", () => {
  it("rejects requests without an API key", async () => {
    expect((await gatewayFetch("/v1/invoices")).status).toBe(401);
  });

  it("rejects requests with a wrong API key", async () => {
    const res = await gatewayFetch("/v1/invoices", {
      headers: { Authorization: "Bearer wrong_key" },
    });
    expect(res.status).toBe(401);
  });

  it("health check needs no auth", async () => {
    expect((await gatewayFetch("/health")).status).toBe(200);
  });
});

describe("response headers on every path", () => {
  // An allowlisted origin from wrangler.jsonc's ALLOWED_ORIGINS.
  const ORIGIN = "http://localhost:5173";

  it("echoes CORS headers on a normal /v1 response", async () => {
    const res = await gatewayFetch("/v1/invoices", {
      headers: { Authorization: `Bearer ${API_KEY}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("does not echo an origin that is not allowlisted", async () => {
    const res = await gatewayFetch("/v1/invoices", {
      headers: { Authorization: `Bearer ${API_KEY}`, Origin: "https://evil.example" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("keeps CORS + security headers on a 404", async () => {
    const res = await gatewayFetch("/v1/nope-does-not-exist", {
      headers: { Authorization: `Bearer ${API_KEY}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("keeps CORS + security headers on a 401", async () => {
    const res = await gatewayFetch("/v1/invoices", { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("answers the CORS preflight for a credentialed write", async () => {
    const res = await gatewayFetch("/v1/auth/invite/accept", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  /**
   * The case worth pinning. A credentialed response missing
   * Access-Control-Allow-Origin is blocked by the browser, so a real server
   * error would reach the SPA as an opaque "failed to fetch" rather than a
   * readable 500 — the hardest kind of production bug to diagnose.
   *
   * Hono gets this right today (cors() sets headers on c.res before next(),
   * and compose converts the throw into onError's response inside the chain so
   * the baseline header middleware still runs). Nothing in the app enforces
   * that, though — it is a property of Hono's internals. This test is the
   * guard against a Hono upgrade or a middleware reordering silently breaking
   * it. Dropping the SESSIONS binding makes the rate limiter throw for real.
   */
  it("keeps CORS + security headers on an unhandled 500", async () => {
    const sessions = env.SESSIONS;
    // @ts-expect-error — deliberately simulating a missing binding.
    delete env.SESSIONS;
    try {
      const res = await gatewayFetch("/v1/auth/invite/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ token: "f".repeat(64), password: "irrelevant-here" }),
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    } finally {
      env.SESSIONS = sessions;
    }
  });
});

describe("gateway routes (native finance)", () => {
  const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

  async function createNativeInvoice(): Promise<string> {
    const res = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: "cust_456",
        currency: "MYR",
        due_date: "2026-06-26",
        lines: [{ description: "Consulting", quantity: 1, unit_cents: 450_000 }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invoice_id: string; status: string; total_cents: number };
    expect(body.status).toBe("draft");
    expect(body.total_cents).toBe(450_000);
    return body.invoice_id;
  }

  it("POST /v1/invoices issues a native invoice", async () => {
    await createNativeInvoice();
  });

  it("GET /v1/invoices?status=draft returns the invoice from D1", async () => {
    const invoiceId = await createNativeInvoice();
    const res = await gatewayFetch("/v1/invoices?status=draft", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invoices: { invoice_id: string }[] };
    expect(body.invoices.map((i) => i.invoice_id)).toContain(invoiceId);
  });

  it("GET /v1/customers/:id returns the customer", async () => {
    const res = await gatewayFetch("/v1/customers/cust_456", { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { customer_id: string }).customer_id).toBe("cust_456");
  });

  it("POST /v1/invoices/:id/reminder sends a templated nudge via the delivery port", async () => {
    const invoiceId = await createNativeInvoice();
    const res = await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "email" }),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { delivery_ref: string }).delivery_ref).toMatch(/^dlv_/);
  });
});
