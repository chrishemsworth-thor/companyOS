import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope } from "../src/schemas/envelope";
import { handleEventBatch } from "../src/queue/consumer";

const API_KEY = "test_api_key_biz_abc123";
const TENANT_ID = "biz_abc123";

async function seedTenant() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Test SME", await sha256Hex(API_KEY))
    .run();
}

function gatewayFetch(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const req = new Request(`https://gateway.test${path}`, init);
  return { response: worker.fetch(req, env, ctx), ctx };
}

const erpnextOverdueWebhook = {
  doctype: "Sales Invoice",
  name: "inv_789",
  customer: "cust_456",
  status: "Overdue",
  outstanding_amount: 4500,
  currency: "MYR",
  due_date: "2026-06-26",
};

beforeAll(seedTenant);

describe("gateway auth", () => {
  it("rejects requests without an API key", async () => {
    const { response } = gatewayFetch("/v1/invoices");
    expect((await response).status).toBe(401);
  });

  it("rejects requests with a wrong API key", async () => {
    const { response } = gatewayFetch("/v1/invoices", {
      headers: { Authorization: "Bearer wrong_key" },
    });
    expect((await response).status).toBe(401);
  });
});

describe("gateway routes (mock adapter)", () => {
  const auth = { Authorization: `Bearer ${API_KEY}` };

  it("GET /v1/invoices?status=overdue returns normalized invoices", async () => {
    const { response } = gatewayFetch("/v1/invoices?status=overdue", { headers: auth });
    const res = await response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invoices: { invoice_id: string }[] };
    expect(body.invoices[0]!.invoice_id).toBe("inv_789");
  });

  it("GET /v1/customers/:id returns the normalized customer", async () => {
    const { response } = gatewayFetch("/v1/customers/cust_456", { headers: auth });
    const res = await response;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { customer_id: string }).customer_id).toBe("cust_456");
  });

  it("POST /v1/invoices/:id/reminder sends a templated nudge", async () => {
    const { response } = gatewayFetch("/v1/invoices/inv_789/reminder", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "email" }),
    });
    const res = await response;
    expect(res.status).toBe(202);
    expect(((await res.json()) as { delivery_ref: string }).delivery_ref).toMatch(/^dlv_/);
  });
});

describe("vertical slice: webhook → queue → agent", () => {
  it("POST /v1/webhooks/erpnext normalizes and enqueues invoice.overdue", async () => {
    const { response, ctx } = gatewayFetch("/v1/webhooks/erpnext", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(erpnextOverdueWebhook),
    });
    const res = await response;
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; event_id: string };
    expect(body.status).toBe("queued");
    expect(body.event_id).toMatch(/^evt_/);
  });

  it("acknowledges but ignores webhooks we don't track", async () => {
    const { response } = gatewayFetch("/v1/webhooks/erpnext", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ doctype: "ToDo", name: "x" }),
    });
    const res = await response;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ignored");
  });

  it("consumer logs the event and the CollectionsAgent sends a reminder + records state", async () => {
    const envelope = makeEnvelope({
      event_type: "invoice.overdue",
      source_module: "finance",
      tenant_id: TENANT_ID,
      payload: {
        invoice_id: "inv_789",
        customer_id: "cust_456",
        amount_due: 4500,
        currency: "MYR",
        days_overdue: 9,
      },
    });

    let acked = 0;
    const batch = {
      queue: "companyos-events",
      messages: [
        {
          id: "msg_1",
          timestamp: new Date(),
          attempts: 1,
          body: envelope,
          ack: () => acked++,
          retry: () => {
            throw new Error("event should not have been retried");
          },
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>;

    await handleEventBatch(batch, env);
    expect(acked).toBe(1);

    // Round trip observable in events_log…
    const logged = await env.DB.prepare("SELECT event_type, tenant_id FROM events_log WHERE event_id = ?")
      .bind(envelope.event_id)
      .first<{ event_type: string; tenant_id: string }>();
    expect(logged).toEqual({ event_type: "invoice.overdue", tenant_id: TENANT_ID });

    // …and in the per-(tenant, customer) Durable Object state.
    const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:cust_456`);
    const stub = env.COLLECTIONS_AGENT.get(id) as unknown as {
      snapshot(): Promise<{
        escalation_stage: string;
        risk_score: number;
        reminder_history: unknown[];
        open_overdue_invoices: string[];
      } | null>;
    };
    const state = await stub.snapshot();
    expect(state).not.toBeNull();
    expect(state!.escalation_stage).toBe("reminded");
    expect(state!.risk_score).toBeGreaterThan(0);
    expect(state!.reminder_history).toHaveLength(1);
    expect(state!.open_overdue_invoices).toEqual(["inv_789"]);
  });

  it("payment.received closes the loop and resets agent state", async () => {
    // Test-pool storage is isolated per test, so establish the overdue state first.
    const overdue = makeEnvelope({
      event_type: "invoice.overdue",
      source_module: "finance",
      tenant_id: TENANT_ID,
      payload: {
        invoice_id: "inv_789",
        customer_id: "cust_456",
        amount_due: 4500,
        currency: "MYR",
        days_overdue: 9,
      },
    });
    const envelope = makeEnvelope({
      event_type: "payment.received",
      source_module: "finance",
      tenant_id: TENANT_ID,
      payload: {
        invoice_id: "inv_789",
        customer_id: "cust_456",
        amount_paid: 4500,
        currency: "MYR",
      },
    });
    const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:cust_456`);
    const stub = env.COLLECTIONS_AGENT.get(id) as unknown as {
      onEvent(e: unknown): Promise<void>;
      snapshot(): Promise<{ escalation_stage: string; open_overdue_invoices: string[] } | null>;
    };
    await stub.onEvent(overdue);
    await stub.onEvent(envelope);
    const state = await stub.snapshot();
    expect(state!.open_overdue_invoices).toEqual([]);
    expect(state!.escalation_stage).toBe("none");
  });
});
