import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope, type EventEnvelope } from "../src/schemas/envelope";
import { handleEventBatch } from "../src/queue/consumer";
import { runOverdueSweep } from "../src/modules/finance/overdue-sweep";

/**
 * The native vertical slice — replaces the ERPNext-webhook leg:
 * POST /v1/invoices → send → cron sweep marks overdue and emits
 * invoice.overdue → queue consumer → CollectionsAgent reminder →
 * payment closes the loop.
 */

const API_KEY = "test_api_key_lifecycle";
const TENANT_ID = "biz_lifecycle";
const CUSTOMER_ID = "cust_life_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

// Fixed clock: invoices due 2026-06-26 are 9 days overdue on 2026-07-05.
const NOW = new Date("2026-07-05T09:00:00Z");
const DUE_DATE = "2026-06-26";

async function seedTenant() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Lifecycle Test SME", await sha256Hex(API_KEY))
    .run();
  // Phase 2: reminders resolve the recipient address from the customers table.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Lifecycle Customer", "life@example.com", NOW.toISOString())
    .run();
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createSentInvoice(): Promise<string> {
  const create = await gatewayFetch("/v1/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: CUSTOMER_ID,
      currency: "MYR",
      due_date: DUE_DATE,
      lines: [{ description: "Retainer", quantity: 1, unit_cents: 450_000 }],
    }),
  });
  expect(create.status).toBe(201);
  const { invoice_id } = (await create.json()) as { invoice_id: string };
  const send = await gatewayFetch(`/v1/invoices/${invoice_id}/send`, {
    method: "POST",
    headers: auth,
  });
  expect(send.status).toBe(200);
  return invoice_id;
}

function makeBatch(envelope: EventEnvelope): { batch: MessageBatch<unknown>; acked: () => number } {
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
  return { batch, acked: () => acked };
}

function agentStub(customerId: string) {
  const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${customerId}`);
  return env.COLLECTIONS_AGENT.get(id) as unknown as {
    onEvent(e: unknown): Promise<void>;
    snapshot(): Promise<{
      escalation_stage: string;
      risk_score: number;
      reminder_history: unknown[];
      open_overdue_invoices: string[];
    } | null>;
  };
}

beforeAll(seedTenant);

describe("native lifecycle: invoice → send → sweep → agent → payment", () => {
  it("the sweep marks sent invoices overdue and emits invoice.overdue.v2", async () => {
    const invoiceId = await createSentInvoice();

    const { marked, events } = await runOverdueSweep(env, NOW);
    expect(marked).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("invoice.overdue");
    expect(events[0]!.tenant_id).toBe(TENANT_ID);
    expect(events[0]!.payload).toMatchObject({
      invoice_id: invoiceId,
      customer_id: CUSTOMER_ID,
      amount_due_cents: 450_000,
      currency: "MYR",
      days_overdue: 9,
    });

    const invoice = (await (
      await gatewayFetch(`/v1/invoices/${invoiceId}`, { headers: auth })
    ).json()) as { status: string };
    expect(invoice.status).toBe("overdue");
  });

  it("the sweep re-emits for invoices already overdue (safety net) but marks nothing new", async () => {
    await createSentInvoice();
    await runOverdueSweep(env, NOW);
    const second = await runOverdueSweep(env, NOW);
    expect(second.marked).toBe(0);
    expect(second.events).toHaveLength(1);
  });

  it("does not touch invoices that are not yet due", async () => {
    const create = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        currency: "MYR",
        due_date: "2099-01-01",
        lines: [{ description: "Future work", quantity: 1, unit_cents: 1_000 }],
      }),
    });
    const { invoice_id } = (await create.json()) as { invoice_id: string };
    await gatewayFetch(`/v1/invoices/${invoice_id}/send`, { method: "POST", headers: auth });

    const { marked, events } = await runOverdueSweep(env, NOW);
    expect(marked).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("sweep events flow through the consumer to the CollectionsAgent", async () => {
    const invoiceId = await createSentInvoice();
    const { events } = await runOverdueSweep(env, NOW);
    const { batch, acked } = makeBatch(events[0]!);

    await handleEventBatch(batch, env);
    expect(acked()).toBe(1);

    const logged = await env.DB.prepare(
      "SELECT event_type, tenant_id FROM events_log WHERE event_id = ?",
    )
      .bind(events[0]!.event_id)
      .first<{ event_type: string; tenant_id: string }>();
    expect(logged).toEqual({ event_type: "invoice.overdue", tenant_id: TENANT_ID });

    const state = await agentStub(CUSTOMER_ID).snapshot();
    expect(state).not.toBeNull();
    expect(state!.escalation_stage).toBe("reminded");
    expect(state!.risk_score).toBeGreaterThan(0);
    expect(state!.open_overdue_invoices).toEqual([invoiceId]);
  });

  it("recording the payment settles the invoice and payment.received resets the agent", async () => {
    const invoiceId = await createSentInvoice();
    const { events } = await runOverdueSweep(env, NOW);
    const stub = agentStub(CUSTOMER_ID);
    await stub.onEvent(events[0]!);

    const pay = await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        amount_cents: 450_000,
        currency: "MYR",
        applications: [{ invoice_id: invoiceId, applied_cents: 450_000 }],
      }),
    });
    expect(pay.status).toBe(201);
    const { payment_id } = (await pay.json()) as { payment_id: string };

    const invoice = (await (
      await gatewayFetch(`/v1/invoices/${invoiceId}`, { headers: auth })
    ).json()) as { status: string };
    expect(invoice.status).toBe("paid");

    // The service emitted payment.received onto the queue; deliver the
    // equivalent envelope to the agent to close the loop.
    await stub.onEvent(
      makeEnvelope({
        event_type: "payment.received",
        source_module: "finance",
        tenant_id: TENANT_ID,
        payload: {
          payment_id,
          invoice_id: invoiceId,
          customer_id: CUSTOMER_ID,
          amount_paid_cents: 450_000,
          currency: "MYR",
        },
      }),
    );
    const state = await stub.snapshot();
    expect(state!.open_overdue_invoices).toEqual([]);
    expect(state!.escalation_stage).toBe("none");
  });
});
