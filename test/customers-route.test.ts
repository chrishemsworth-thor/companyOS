import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope } from "../src/schemas/envelope";
import { setLlmProviderFactoryForTests } from "../src/llm";
import { setEventSenderForTests } from "../src/queue/producer";

/** PATCH /v1/customers/:id and GET /v1/customers/:id/agent. */

const API_KEY = "test_api_key_custroute";
const TENANT_ID = "biz_custroute";
const CUSTOMER_ID = "cust_route_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

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
    .bind(TENANT_ID, "Customer Route SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Original Name", "orig@example.com", new Date().toISOString())
    .run();
});

beforeEach(() => {
  setEventSenderForTests(async () => {});
  setLlmProviderFactoryForTests(() => ({
    name: "anthropic",
    completeStructured: vi.fn().mockResolvedValue({
      risk_score: 42,
      action: "remind",
      channel: "email",
      message: "Please pay soon.",
    }),
  }));
});

afterEach(() => {
  setEventSenderForTests(null);
  setLlmProviderFactoryForTests(null);
});

describe("PATCH /v1/customers/:id", () => {
  it("applies a partial update and returns the customer", async () => {
    const res = await gatewayFetch(`/v1/customers/${CUSTOMER_ID}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ phone: "+60123456789" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; email: string; phone: string };
    expect(body.phone).toBe("+60123456789");
    expect(body.name).toBe("Original Name");
    expect(body.email).toBe("orig@example.com");
  });

  it("rejects an empty patch", async () => {
    const res = await gatewayFetch(`/v1/customers/${CUSTOMER_ID}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s for a customer in another tenant / unknown id", async () => {
    const res = await gatewayFetch("/v1/customers/cust_missing", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/customers/:id/agent", () => {
  it("returns null when the collections agent has never run", async () => {
    const res = await gatewayFetch(`/v1/customers/cust_untouched/agent`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent_state: unknown }).agent_state).toBeNull();
  });

  it("returns the agent snapshot without tenant_id after the agent has acted", async () => {
    // The agent assembles its context from D1, so it needs a real overdue invoice.
    const createRes = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        currency: "MYR",
        due_date: "2026-06-20",
        lines: [{ description: "Consulting", quantity: 1, unit_cents: 90_000 }],
      }),
    });
    expect(createRes.status).toBe(201);
    const { invoice_id } = (await createRes.json()) as { invoice_id: string };
    await gatewayFetch(`/v1/invoices/${invoice_id}/send`, { method: "POST", headers: auth });
    await env.DB.prepare(
      "UPDATE invoices SET status = 'overdue' WHERE tenant_id = ? AND invoice_id = ?",
    )
      .bind(TENANT_ID, invoice_id)
      .run();

    const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${CUSTOMER_ID}`);
    const stub = env.COLLECTIONS_AGENT.get(id) as unknown as {
      onEvent(e: unknown): Promise<void>;
    };
    await stub.onEvent(
      makeEnvelope({
        event_type: "invoice.overdue",
        source_module: "finance",
        tenant_id: TENANT_ID,
        payload: {
          invoice_id,
          customer_id: CUSTOMER_ID,
          amount_due_cents: 90_000,
          currency: "MYR",
          days_overdue: 10,
        },
      }),
    );

    const res = await gatewayFetch(`/v1/customers/${CUSTOMER_ID}/agent`, { headers: auth });
    expect(res.status).toBe(200);
    const { agent_state } = (await res.json()) as {
      agent_state: Record<string, unknown> | null;
    };
    expect(agent_state).not.toBeNull();
    expect(agent_state!.customer_id).toBe(CUSTOMER_ID);
    expect(agent_state!.risk_score).toBe(42);
    expect(agent_state!.escalation_stage).toBe("reminded");
    expect(agent_state).not.toHaveProperty("tenant_id");
  });
});
