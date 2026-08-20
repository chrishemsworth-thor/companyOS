import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope } from "../src/schemas/envelope";
import { handleEventBatch } from "../src/queue/consumer";
import { validatePayload } from "../src/schemas/events/registry";
import type { AgentInsights } from "../src/modules/insights/service";

/**
 * `GET /v1/insights/agents` and the two decision-observability acceptance
 * criteria behind it (PRD-002):
 *
 *   - "Given any decision, then provider, model, and prompt version are
 *     queryable from `events_log`."
 *   - "Given a month of decisions, then total LLM spend for a tenant is
 *     derivable."
 *
 * Events are fed through the real consumer so they land in `events_log` the way
 * production writes them — including registry validation, which is what makes
 * the v2 payload a contract rather than a hope.
 */

const API_KEY = "test_api_key_agentinsights";
const TENANT_ID = "biz_agentins";
const OTHER_TENANT = "biz_agentins_other";
const CUSTOMER_ID = "cust_agentins_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface DecisionOverrides {
  action?: "remind" | "escalate" | "wait";
  source?: "llm" | "fallback";
  model?: string | null;
  provider?: "anthropic" | "openai" | null;
  cost_micros?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  latency_ms?: number;
  guardrail_overridden?: boolean;
  overrides?: string[];
  occurred_at?: string;
  tenant_id?: string;
}

function decisionEvent(over: DecisionOverrides = {}) {
  const envelope = makeEnvelope({
    event_type: "collections.decision",
    source_module: "finance",
    tenant_id: over.tenant_id ?? TENANT_ID,
    payload: {
      customer_id: CUSTOMER_ID,
      risk_score: 55,
      action: over.action ?? "remind",
      channel: "email",
      message: "Friendly reminder: invoice inv_ins_1 is overdue.",
      source: over.source ?? "llm",
      trigger: "event",
      invoice_id: "inv_ins_1",
      contact_id: null,
      contact_match: null,
      provider: over.provider === undefined ? "anthropic" : over.provider,
      model: over.model === undefined ? "claude-opus-4-8" : over.model,
      prompt_version: "collections-2026-08-20",
      input_tokens: over.input_tokens === undefined ? 1_200 : over.input_tokens,
      output_tokens: over.output_tokens === undefined ? 180 : over.output_tokens,
      latency_ms: over.latency_ms ?? 900,
      cost_micros: over.cost_micros === undefined ? 10_500 : over.cost_micros,
      fallback_reason: (over.source ?? "llm") === "fallback" ? "no_provider" : null,
      guardrail_overridden: over.guardrail_overridden ?? false,
      overrides: over.overrides ?? [],
      deferred_until: null,
    },
  });
  return over.occurred_at ? { ...envelope, occurred_at: over.occurred_at } : envelope;
}

function overrideEvent(guardrail: string, occurred_at?: string) {
  const envelope = makeEnvelope({
    event_type: "guardrail.override",
    source_module: "finance",
    tenant_id: TENANT_ID,
    payload: {
      agent: "collections",
      subject_type: "customer",
      subject_id: CUSTOMER_ID,
      channel: "email",
      guardrail,
      outcome: guardrail === "contact_window" ? "deferred" : "downgraded",
      from_action: "escalate",
      to_action: "remind",
      subject_ref: "inv_ins_1",
      detail: "test",
      defer_until: null,
    },
  });
  return occurred_at ? { ...envelope, occurred_at } : envelope;
}

/** Through the real consumer, so registry validation applies. */
async function ingest(...envelopes: unknown[]): Promise<void> {
  const messages = envelopes.map((body, i) => ({
    id: `msg_${i}_${Math.floor(Math.random() * 1e9)}`,
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

async function insights(query = ""): Promise<AgentInsights> {
  const res = await fetchWorker(`/v1/insights/agents${query}`, { headers: auth });
  expect(res.status).toBe(200);
  return (await res.json()) as AgentInsights;
}

beforeAll(async () => {
  for (const [tenant, key] of [
    [TENANT_ID, API_KEY],
    [OTHER_TENANT, "other_agentins_key"],
  ]) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
    )
      .bind(tenant, `Insights ${tenant}`, await sha256Hex(key!))
      .run();
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Insights Co", "2026-01-01T00:00:00.000Z")
    .run();
});

describe("the v2 decision payload in events_log", () => {
  it("makes provider, model and prompt version queryable", async () => {
    // PRD-002's first observability acceptance criterion, asserted as a query
    // rather than as an object we just built.
    await ingest(decisionEvent());
    const row = await env.DB.prepare(
      `SELECT json_extract(payload, '$.provider') AS provider,
              json_extract(payload, '$.model') AS model,
              json_extract(payload, '$.prompt_version') AS prompt_version,
              json_extract(payload, '$.invoice_id') AS invoice_id
       FROM events_log WHERE tenant_id = ? AND event_type = 'collections.decision'`,
    )
      .bind(TENANT_ID)
      .first<{ provider: string; model: string; prompt_version: string; invoice_id: string }>();
    expect(row).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      prompt_version: "collections-2026-08-20",
      // PRD-002's P2 outcome scoring is a query over this, not a migration.
      invoice_id: "inv_ins_1",
    });
  });

  it("refuses a decision that is missing the v2 fields", () => {
    // The v1 shape no longer validates — which is exactly why this is a v2 file
    // and a registry bump rather than an edit to v1.
    const v1Payload = {
      customer_id: CUSTOMER_ID,
      risk_score: 55,
      action: "remind",
      channel: "email",
      message: "Friendly reminder.",
      source: "llm",
      trigger: "event",
    };
    expect(validatePayload("collections.decision", v1Payload).ok).toBe(false);
  });

  it("accepts the payload the agent actually emits", async () => {
    const envelope = decisionEvent({ action: "escalate", guardrail_overridden: true, overrides: ["escalation_gate"] });
    expect(validatePayload("collections.decision", envelope.payload)).toEqual({ ok: true });
    await ingest(envelope);
  });
});

describe("GET /v1/insights/agents", () => {
  it("counts decisions by outcome", async () => {
    await ingest(
      decisionEvent({ action: "remind" }),
      decisionEvent({ action: "remind" }),
      decisionEvent({ action: "escalate" }),
      decisionEvent({ action: "wait" }),
    );
    const body = await insights();
    expect(body.decisions.total).toBe(4);
    expect(body.decisions.by_action).toEqual({ remind: 2, escalate: 1, wait: 1 });
  });

  it("reports the fallback rate PRD-002 holds under 5%", async () => {
    await ingest(
      decisionEvent({ source: "llm" }),
      decisionEvent({ source: "llm" }),
      decisionEvent({ source: "llm" }),
      decisionEvent({ source: "fallback", provider: null, model: null, cost_micros: null, input_tokens: null, output_tokens: null }),
    );
    const body = await insights();
    expect(body.fallback).toEqual({ count: 1, rate: 0.25 });
  });

  it("reports the override rate, and guardrail firings separately", async () => {
    // The two are different numbers on purpose: one decision can trip two rules,
    // and the pre-send gate fires without any decision at all.
    await ingest(
      decisionEvent({ guardrail_overridden: true, overrides: ["escalation_gate", "message_length"] }),
      decisionEvent({ guardrail_overridden: false }),
      overrideEvent("escalation_gate"),
      overrideEvent("message_length"),
      overrideEvent("contact_window"),
    );
    const body = await insights();
    expect(body.overrides.decisions_overridden).toBe(1);
    expect(body.overrides.rate).toBe(0.5);
    expect(body.overrides.firings).toBe(3);
    expect(body.overrides.by_guardrail).toEqual({
      escalation_gate: 1,
      message_length: 1,
      contact_window: 1,
    });
  });

  it("derives a month of LLM spend for the tenant", async () => {
    // PRD-002's second observability acceptance criterion.
    await ingest(
      ...Array.from({ length: 30 }, (_, day) =>
        decisionEvent({
          occurred_at: `2026-07-${String(day + 1).padStart(2, "0")}T02:00:00.000Z`,
          cost_micros: 10_500,
        }),
      ),
    );
    const body = await insights("?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.000Z");
    expect(body.decisions.total).toBe(30);
    // 30 decisions × 10,500 micro-USD = $0.315
    expect(body.spend.cost_micros).toBe(315_000);
    expect(body.spend.input_tokens).toBe(36_000);
    expect(body.spend.output_tokens).toBe(5_400);
    expect(body.by_month).toEqual([
      { month: "2026-07", decisions: 30, fallbacks: 0, overridden: 0, cost_micros: 315_000 },
    ]);
  });

  it("says how many decisions it could not price, rather than understating spend", async () => {
    await ingest(
      decisionEvent({ cost_micros: 10_500 }),
      decisionEvent({ cost_micros: null, model: "some-local-llama" }),
    );
    const body = await insights();
    expect(body.spend).toMatchObject({
      cost_micros: 10_500,
      priced_decisions: 1,
      unpriced_decisions: 1,
    });
  });

  it("reports p95 and max latency", async () => {
    await ingest(
      ...[100, 200, 300, 400, 5_000].map((latency_ms) => decisionEvent({ latency_ms })),
    );
    const body = await insights();
    // Nearest-rank over 5 samples: the 5th, which is a latency a request had.
    expect(body.latency_ms).toEqual({ p95: 5_000, max: 5_000 });
  });

  it("breaks down which provider, model and prompt produced the decisions", async () => {
    await ingest(
      decisionEvent({ model: "claude-opus-4-8" }),
      decisionEvent({ model: "claude-opus-4-8" }),
      decisionEvent({ provider: "openai", model: "gpt-5" }),
    );
    const body = await insights();
    expect(body.models).toEqual([
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        prompt_version: "collections-2026-08-20",
        decisions: 2,
      },
      {
        provider: "openai",
        model: "gpt-5",
        prompt_version: "collections-2026-08-20",
        decisions: 1,
      },
    ]);
  });

  it("buckets spend by month across a year", async () => {
    await ingest(
      decisionEvent({ occurred_at: "2026-06-15T02:00:00.000Z", cost_micros: 1_000 }),
      decisionEvent({ occurred_at: "2026-07-15T02:00:00.000Z", cost_micros: 2_000 }),
      decisionEvent({ occurred_at: "2026-07-16T02:00:00.000Z", cost_micros: 3_000, source: "fallback" }),
      decisionEvent({ occurred_at: "2026-08-15T02:00:00.000Z", cost_micros: 4_000 }),
    );
    const body = await insights("?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z");
    expect(body.by_month).toEqual([
      { month: "2026-06", decisions: 1, fallbacks: 0, overridden: 0, cost_micros: 1_000 },
      { month: "2026-07", decisions: 2, fallbacks: 1, overridden: 0, cost_micros: 5_000 },
      { month: "2026-08", decisions: 1, fallbacks: 0, overridden: 0, cost_micros: 4_000 },
    ]);
  });

  it("returns zeroes rather than nulls for a tenant whose agent has never run", async () => {
    const body = await insights();
    expect(body.decisions.total).toBe(0);
    expect(body.fallback).toEqual({ count: 0, rate: 0 });
    expect(body.overrides.rate).toBe(0);
    expect(body.spend.cost_micros).toBe(0);
    expect(body.latency_ms).toEqual({ p95: 0, max: 0 });
    expect(body.models).toEqual([]);
    expect(body.by_month).toEqual([]);
  });

  it("never counts another tenant's decisions", async () => {
    await ingest(decisionEvent(), decisionEvent({ tenant_id: OTHER_TENANT }));
    const body = await insights();
    expect(body.decisions.total).toBe(1);
  });

  it("honours the window, excluding decisions outside it", async () => {
    await ingest(
      decisionEvent({ occurred_at: "2025-01-01T02:00:00.000Z" }),
      decisionEvent({ occurred_at: "2026-08-19T02:00:00.000Z" }),
    );
    const body = await insights("?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z");
    expect(body.decisions.total).toBe(1);
    expect(body.period.from).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects a malformed window", async () => {
    const res = await fetchWorker("/v1/insights/agents?from=last-tuesday", { headers: auth });
    expect(res.status).toBe(400);
  });
});
