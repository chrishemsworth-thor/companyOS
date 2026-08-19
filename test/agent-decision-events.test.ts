import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope, type EventEnvelope } from "../src/schemas/envelope";
import { eventRegistry, validatePayload } from "../src/schemas/events/registry";
import { collectionsDecisionV1 } from "../src/schemas/events/collections.decision.v1";
import { collectionsDecisionV2 } from "../src/schemas/events/collections.decision.v2";
import { guardrailOverrideV1 } from "../src/schemas/events/guardrail.override.v1";
import { setEventSenderForTests } from "../src/queue/producer";
import { setLlmProviderFactoryForTests } from "../src/llm";
import { handleEventBatch } from "../src/queue/consumer";
import { openContactWindow, stubLlmProvider } from "./agent-fixture";

/**
 * The event contract S10 changes: `collections.decision` moves to v2 and
 * `guardrail.override.v1` arrives.
 *
 * The point of this file is that v2 is a **breaking** payload change — which is
 * why the SESSION-PLAN event table calls for a v2 file and a registry bump
 * rather than an edit — and that the events feed can still find both by the
 * customer and invoice they are about.
 */

const API_KEY = "test_api_key_decisionv2";
const TENANT_ID = "biz_decv2";
const CUSTOMER_ID = "cust_decv2_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Decision v2 SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Decision Co", "ap@decision.example", "2026-01-01T00:00:00.000Z")
    .run();
  await openContactWindow(TENANT_ID);
});

let captured: EventEnvelope[];
let llmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  captured = [];
  setEventSenderForTests(async (_env, envelope) => {
    captured.push(envelope);
  });
  llmMock = vi.fn();
  stubLlmProvider(llmMock);
});

afterEach(() => {
  setEventSenderForTests(null);
  setLlmProviderFactoryForTests(null);
  vi.useRealTimers();
});

const V2_ONLY_FIELDS = [
  "invoice_id",
  "provider",
  "model",
  "prompt_version",
  "input_tokens",
  "output_tokens",
  "latency_ms",
  "cost_micros",
  "fallback_reason",
  "guardrail_overridden",
  "overrides",
  "deferred_until",
];

describe("the registry", () => {
  it("maps collections.decision to v2", () => {
    expect(eventRegistry["collections.decision"]).toBe(collectionsDecisionV2);
  });

  it("registers guardrail.override", () => {
    expect(eventRegistry["guardrail.override"]).toBe(guardrailOverrideV1);
  });

  it("keeps v1 as a file, because history was written against it", () => {
    // Events already in events_log were validated when they were written and
    // are never re-validated; the v1 schema stays so a reader of that history
    // has something to read it with.
    const v1Payload = {
      customer_id: CUSTOMER_ID,
      risk_score: 55,
      action: "remind",
      channel: "email",
      message: "Friendly reminder.",
      source: "llm",
      trigger: "event",
    };
    expect(collectionsDecisionV1.safeParse(v1Payload).success).toBe(true);
    // And the same payload is NOT a valid v2 — which is the definition of a
    // breaking change, and the reason this is a v2 file and a registry bump.
    expect(collectionsDecisionV2.safeParse(v1Payload).success).toBe(false);
    expect(validatePayload("collections.decision", v1Payload).ok).toBe(false);
  });

  it("requires every field PRD-002 asks the decision to record", () => {
    const complete = {
      customer_id: CUSTOMER_ID,
      risk_score: 55,
      action: "remind",
      channel: "email",
      message: "Friendly reminder: invoice inv_1 is overdue.",
      source: "llm",
      trigger: "event",
      invoice_id: "inv_1",
      contact_id: null,
      contact_match: null,
      provider: "anthropic",
      model: "claude-opus-4-8",
      prompt_version: "collections-2026-08-19",
      input_tokens: 1_200,
      output_tokens: 180,
      latency_ms: 900,
      cost_micros: 10_500,
      fallback_reason: null,
      guardrail_overridden: false,
      overrides: [],
      deferred_until: null,
    };
    expect(validatePayload("collections.decision", complete)).toEqual({ ok: true });
    // Dropping any one of the new fields is rejected, so a producer cannot
    // half-migrate and a consumer can rely on them being there.
    for (const field of V2_ONLY_FIELDS) {
      const partial = { ...complete } as Record<string, unknown>;
      delete partial[field];
      expect(validatePayload("collections.decision", partial).ok, field).toBe(false);
    }
  });

  it("rejects a guardrail override naming a rule that does not exist", () => {
    const payload = {
      agent: "collections",
      subject_type: "customer",
      subject_id: CUSTOMER_ID,
      channel: "email",
      guardrail: "vibes",
      outcome: "downgraded",
      from_action: "escalate",
      to_action: "remind",
      subject_ref: "inv_1",
      detail: "no",
      defer_until: null,
    };
    expect(validatePayload("guardrail.override", payload).ok).toBe(false);
  });

  it("accepts a sales guardrail override, so S15 does not need a second event", () => {
    // Conflict C9: one override event for every agent that messages a person.
    const payload = {
      agent: "sales",
      subject_type: "customer",
      subject_id: CUSTOMER_ID,
      channel: "whatsapp",
      guardrail: "contact_window",
      outcome: "deferred",
      from_action: null,
      to_action: null,
      subject_ref: "deal_123",
      detail: "outside the contact window (non_working_day)",
      defer_until: "2026-08-24T01:00:00.000Z",
    };
    expect(validatePayload("guardrail.override", payload)).toEqual({ ok: true });
  });
});

describe("what the agent actually emits", () => {
  async function drive(): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO invoices (invoice_id, tenant_id, customer_id, status, amount_due_cents, currency, due_date)
       VALUES ('inv_decv2_1', ?, ?, 'overdue', 250000, 'MYR', '2026-06-01')`,
    )
      .bind(TENANT_ID, CUSTOMER_ID)
      .run();
    const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${CUSTOMER_ID}`);
    const stub = env.COLLECTIONS_AGENT.get(id) as unknown as { onEvent(e: unknown): Promise<void> };
    await stub.onEvent(
      makeEnvelope({
        event_type: "invoice.overdue",
        source_module: "finance",
        tenant_id: TENANT_ID,
        payload: {
          invoice_id: "inv_decv2_1",
          customer_id: CUSTOMER_ID,
          amount_due_cents: 250_000,
          currency: "MYR",
          days_overdue: 79,
        },
      }),
    );
  }

  it("emits a schema-valid v2 decision carrying provider, model, tokens and cost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T04:00:00Z"));
    llmMock.mockResolvedValue({
      risk_score: 61,
      action: "remind",
      channel: "email",
      message: "Gentle reminder about invoice inv_decv2_1.",
    });

    await drive();

    const decision = captured.find((e) => e.event_type === "collections.decision");
    expect(decision).toBeDefined();
    expect(validatePayload("collections.decision", decision!.payload)).toEqual({ ok: true });
    expect(decision!.payload).toMatchObject({
      customer_id: CUSTOMER_ID,
      invoice_id: "inv_decv2_1",
      action: "remind",
      source: "llm",
      provider: "anthropic",
      model: "claude-opus-4-8",
      prompt_version: "collections-2026-08-19",
      input_tokens: 1_200,
      output_tokens: 180,
      // 1,200 in + 180 out on claude-opus-4-8 at $5/$25 per MTok.
      cost_micros: 10_500,
      fallback_reason: null,
      guardrail_overridden: false,
      overrides: [],
      deferred_until: null,
    });
  });

  it("records the fallback and its reason when no model is configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T04:00:00Z"));
    setLlmProviderFactoryForTests(() => null);

    await drive();

    const decision = captured.find((e) => e.event_type === "collections.decision")!;
    expect(validatePayload("collections.decision", decision.payload)).toEqual({ ok: true });
    expect(decision.payload).toMatchObject({
      source: "fallback",
      provider: null,
      model: null,
      input_tokens: null,
      output_tokens: null,
      // No model, no rate, no invented number.
      cost_micros: null,
      fallback_reason: "no_provider",
    });
  });

  it("records which guardrails fired on the decision itself", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T04:00:00Z"));
    llmMock.mockResolvedValue({
      risk_score: 99,
      action: "escalate",
      channel: "email",
      message: "Final notice for invoice INV-0000.",
    });

    await drive();

    const decision = captured.find((e) => e.event_type === "collections.decision")!;
    expect(decision.payload).toMatchObject({
      action: "remind",
      guardrail_overridden: true,
    });
    // One firing, not two, and the order is why: the escalation gate runs first
    // and replaces the message with the template for the action it settled on,
    // so by the time the reference check runs there is no invented invoice left
    // to reject. The hallucinated INV-0000 never reaches the customer either way.
    expect(decision.payload.overrides).toEqual(["escalation_gate"]);
    expect(decision.payload.message).not.toContain("INV-0000");
    expect(decision.payload.message).toContain("inv_decv2_1");

    const overrides = captured.filter((e) => e.event_type === "guardrail.override");
    expect(overrides).toHaveLength(1);
    expect(validatePayload("guardrail.override", overrides[0]!.payload)).toEqual({ ok: true });
    expect(overrides[0]!.payload).toMatchObject({
      agent: "collections",
      guardrail: "escalation_gate",
      outcome: "downgraded",
      subject_ref: "inv_decv2_1",
    });
  });
});

describe("the events feed", () => {
  /** Through the real consumer, so these land in events_log as production writes them. */
  async function ingest(...envelopes: unknown[]): Promise<void> {
    const messages = envelopes.map((body, i) => ({
      id: `msg_feed_${i}_${Math.floor(Math.random() * 1e9)}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    }));
    await handleEventBatch(
      { queue: "companyos-events", messages } as unknown as MessageBatch<unknown>,
      env,
    );
  }

  const override = makeEnvelope({
    event_type: "guardrail.override",
    source_module: "finance",
    tenant_id: TENANT_ID,
    payload: {
      agent: "collections",
      subject_type: "customer",
      subject_id: CUSTOMER_ID,
      channel: "email",
      guardrail: "escalation_gate",
      outcome: "downgraded",
      from_action: "escalate",
      to_action: "remind",
      subject_ref: "inv_decv2_1",
      detail: "2 day(s) past due, threshold 60",
      defer_until: null,
    },
  });

  it("serves guardrail overrides alongside decisions", async () => {
    await ingest(override);
    const res = await fetchWorker("/v1/events?type=guardrail.override", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { event_type: string; payload: unknown }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.payload).toMatchObject({ guardrail: "escalation_gate" });
  });

  it("finds an override by the customer it was about", async () => {
    // The payload says `subject_id`, not `customer_id` — it is agent-agnostic by
    // design — so the feed has to look under both keys or the customer page
    // silently omits every guardrail firing.
    await ingest(override);
    const res = await fetchWorker(`/v1/events?customer_id=${CUSTOMER_ID}`, { headers: auth });
    const body = (await res.json()) as { items: { event_type: string }[] };
    expect(body.items.map((i) => i.event_type)).toContain("guardrail.override");
  });

  it("finds an override by the invoice it was about", async () => {
    await ingest(override);
    const res = await fetchWorker("/v1/events?invoice_id=inv_decv2_1", { headers: auth });
    const body = (await res.json()) as { items: { event_type: string }[] };
    expect(body.items.map((i) => i.event_type)).toContain("guardrail.override");
  });
});
