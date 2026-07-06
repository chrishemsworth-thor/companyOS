import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope, type EventEnvelope } from "../src/schemas/envelope";
import { validatePayload } from "../src/schemas/events/registry";
import { setLlmProviderFactoryForTests } from "../src/llm";
import { setEventSenderForTests } from "../src/queue/producer";
import type { CollectionsDecision } from "../src/agents/decision";

/**
 * Workstream 2 — the smart CollectionsAgent. The LLM is stubbed through the
 * provider factory (never a live API call); emitted events are captured
 * through the producer seam instead of draining the queue.
 */

const API_KEY = "test_api_key_agent";
const TENANT_ID = "biz_agent";
const CUSTOMER_ID = "cust_agent_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Agent Test SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Slow Payer Sdn Bhd", "slow@example.com", new Date().toISOString())
    .run();
}

beforeAll(seed);

let capturedEvents: EventEnvelope[];
let llmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  capturedEvents = [];
  setEventSenderForTests(async (_env, envelope) => {
    capturedEvents.push(envelope);
  });
  llmMock = vi.fn();
  setLlmProviderFactoryForTests(() => ({
    name: "anthropic",
    completeStructured: llmMock,
  }));
});

afterEach(() => {
  setEventSenderForTests(null);
  setLlmProviderFactoryForTests(null);
});

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A real invoice in D1, forced overdue — the agent assembles context from the DB. */
async function createOverdueInvoice(amountCents = 120_000): Promise<string> {
  const res = await gatewayFetch("/v1/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: CUSTOMER_ID,
      currency: "MYR",
      due_date: "2026-06-20",
      lines: [{ description: "Consulting", quantity: 1, unit_cents: amountCents }],
    }),
  });
  expect(res.status).toBe(201);
  const { invoice_id } = (await res.json()) as { invoice_id: string };
  await gatewayFetch(`/v1/invoices/${invoice_id}/send`, { method: "POST", headers: auth });
  await env.DB.prepare(
    "UPDATE invoices SET status = 'overdue' WHERE tenant_id = ? AND invoice_id = ?",
  )
    .bind(TENANT_ID, invoice_id)
    .run();
  return invoice_id;
}

function agentStub() {
  const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${CUSTOMER_ID}`);
  return env.COLLECTIONS_AGENT.get(id) as unknown as {
    onEvent(e: unknown): Promise<void>;
    snapshot(): Promise<{
      risk_score: number;
      escalation_stage: string;
      last_contact: string | null;
      reminder_history: unknown[];
      open_overdue_invoices: string[];
    } | null>;
  };
}

function overdueEnvelope(invoiceId: string, amountCents = 120_000): EventEnvelope {
  return makeEnvelope({
    event_type: "invoice.overdue",
    source_module: "finance",
    tenant_id: TENANT_ID,
    payload: {
      invoice_id: invoiceId,
      customer_id: CUSTOMER_ID,
      amount_due_cents: amountCents,
      currency: "MYR",
      days_overdue: 16,
    },
  });
}

async function reminderActivities(): Promise<{ kind: string; body: string | null }[]> {
  const { results } = await env.DB.prepare(
    "SELECT kind, body FROM activities WHERE tenant_id = ? AND customer_id = ? AND kind = 'reminder_sent'",
  )
    .bind(TENANT_ID, CUSTOMER_ID)
    .all<{ kind: string; body: string | null }>();
  return results;
}

const REMIND: CollectionsDecision = {
  risk_score: 55,
  action: "remind",
  channel: "email",
  message: "Hi! Gentle nudge about your open invoice — could you arrange payment this week?",
};

describe("LLM-driven decisions", () => {
  it("remind: stores the risk score, sends the composed message, logs the activity + decision", async () => {
    const invoiceId = await createOverdueInvoice();
    llmMock.mockResolvedValue(REMIND);

    await agentStub().onEvent(overdueEnvelope(invoiceId));

    // The LLM saw the assembled context.
    const [req] = llmMock.mock.calls[0] as [{ system: string; prompt: string }];
    expect(req.prompt).toContain(invoiceId);
    expect(req.prompt).toContain("MYR 1200.00");
    expect(req.system).toContain("collections agent");

    const state = await agentStub().snapshot();
    expect(state!.risk_score).toBe(55);
    expect(state!.escalation_stage).toBe("reminded");
    expect(state!.reminder_history).toHaveLength(1);

    const activities = await reminderActivities();
    expect(activities).toHaveLength(1);

    // The composed message went through the delivery port (console → logged).
    const delivery = await env.DB.prepare(
      "SELECT channel, provider, to_address, status FROM deliveries WHERE tenant_id = ? AND customer_id = ?",
    )
      .bind(TENANT_ID, CUSTOMER_ID)
      .first<{ channel: string; provider: string; to_address: string; status: string }>();
    expect(delivery).toMatchObject({
      channel: "email",
      provider: "console",
      to_address: "slow@example.com",
      status: "sent",
    });

    // Full decision audited as collections.decision.v1, schema-valid.
    const decision = capturedEvents.find((e) => e.event_type === "collections.decision");
    expect(decision).toBeDefined();
    expect(validatePayload("collections.decision", decision!.payload)).toEqual({ ok: true });
    expect(decision!.payload).toMatchObject({
      customer_id: CUSTOMER_ID,
      risk_score: 55,
      action: "remind",
      message: REMIND.message,
      source: "llm",
      trigger: "event",
    });
  });

  it("escalate: emits customer.risk_flagged.v1 and marks the stage escalated", async () => {
    const invoiceId = await createOverdueInvoice(300_000);
    llmMock.mockResolvedValue({
      risk_score: 90,
      action: "escalate",
      channel: "email",
      message: "Final notice: your invoice remains unpaid despite reminders.",
    });

    await agentStub().onEvent(overdueEnvelope(invoiceId, 300_000));

    const state = await agentStub().snapshot();
    expect(state!.escalation_stage).toBe("escalated");
    expect(state!.risk_score).toBe(90);

    const flagged = capturedEvents.find((e) => e.event_type === "customer.risk_flagged");
    expect(flagged).toBeDefined();
    expect(validatePayload("customer.risk_flagged", flagged!.payload)).toEqual({ ok: true });
    expect(flagged!.payload).toEqual({
      customer_id: CUSTOMER_ID,
      risk_score: 90,
      open_invoices: [invoiceId],
      total_due_cents: 300_000,
    });

    // Escalation notices still reach the customer and the activity log.
    expect(await reminderActivities()).toHaveLength(1);
  });

  it("wait: updates the risk score but sends nothing", async () => {
    const invoiceId = await createOverdueInvoice();
    llmMock.mockResolvedValue({
      risk_score: 20,
      action: "wait",
      channel: "email",
      message: "(no contact needed)",
    });

    await agentStub().onEvent(overdueEnvelope(invoiceId));

    const state = await agentStub().snapshot();
    expect(state!.risk_score).toBe(20);
    expect(state!.escalation_stage).toBe("none");
    expect(state!.last_contact).toBeNull();
    expect(await reminderActivities()).toHaveLength(0);
  });
});

describe("fallback path", () => {
  it("LLM API failure → template reminder still goes out, decision audited as fallback", async () => {
    const invoiceId = await createOverdueInvoice();
    llmMock.mockRejectedValue(new Error("api down"));

    await agentStub().onEvent(overdueEnvelope(invoiceId));

    const state = await agentStub().snapshot();
    expect(state!.escalation_stage).toBe("reminded");
    expect(state!.risk_score).toBeGreaterThan(0);
    expect(await reminderActivities()).toHaveLength(1);

    const decision = capturedEvents.find((e) => e.event_type === "collections.decision");
    expect(decision!.payload).toMatchObject({ source: "fallback", action: "remind" });
  });

  it("schema-invalid LLM output → fallback (Zod gate)", async () => {
    const invoiceId = await createOverdueInvoice();
    llmMock.mockResolvedValue({ risk_score: 999, action: "obliterate" });

    await agentStub().onEvent(overdueEnvelope(invoiceId));

    const decision = capturedEvents.find((e) => e.event_type === "collections.decision");
    expect(decision!.payload).toMatchObject({ source: "fallback" });
    expect(await reminderActivities()).toHaveLength(1);
  });
});

describe("rate limiting", () => {
  it("never contacts the same customer twice within 24h, but keeps tracking invoices", async () => {
    const first = await createOverdueInvoice();
    const second = await createOverdueInvoice();
    llmMock.mockResolvedValue(REMIND);

    await agentStub().onEvent(overdueEnvelope(first));
    await agentStub().onEvent(overdueEnvelope(second));

    expect(await reminderActivities()).toHaveLength(1);
    expect(llmMock).toHaveBeenCalledTimes(1); // cooldown gate sits before the LLM spend

    const state = await agentStub().snapshot();
    expect(state!.open_overdue_invoices).toEqual(expect.arrayContaining([first, second]));
  });
});
