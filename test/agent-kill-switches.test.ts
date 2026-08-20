import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope, type EventEnvelope } from "../src/schemas/envelope";
import { validatePayload } from "../src/schemas/events/registry";
import { setLlmProviderFactoryForTests } from "../src/llm";
import { setEventSenderForTests } from "../src/queue/producer";
import { stubLlmProvider } from "./agent-fixture";
import type { CollectionsDecision } from "../src/agents/decision";

/**
 * PRD-002's kill switches, the per-invoice cap, and the fallback guarantee —
 * through the real CollectionsAgent.
 *
 * The kill switches (`agents.enabled`, `customers.agent_paused`), the
 * per-invoice reminder cap, and the fallback guarantee. Each is an acceptance
 * criterion in PRD-002's "Hard guardrails in code".
 *
 * The clock is faked throughout — the guard's whole job is to know what time it
 * is where the tenant is — and pinned years ahead, for the reason in the
 * `afterEach` below.
 *
 * **One integration test per mechanism.** What lives here needs a Durable
 * Object: the events, the send, the settings coming out of D1. The arithmetic
 * and string handling is asserted directly against `applyDecisionGuards` in
 * `test/agent-decision-guards.test.ts`, and the timezone and window maths in
 * `test/agent-guardrails-window.test.ts`.
 */

const API_KEY = "test_api_key_killswitch";
const TENANT_ID = "biz_killswitch";
const CUSTOMER_ID = "cust_killswitch_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

/**
 * Noon in Kuala Lumpur on a working day. Pinned years ahead deliberately: a
 * frozen clock in the real past makes `setAlarm(now + 24h)` fire immediately,
 * because miniflare schedules alarms on the real clock while `Date.now()` is
 * faked. See `agent-guardrails.test.ts` for the full note.
 */
const NOON_KL_WED = "2029-08-15T04:00:00Z";
/** 23:00 in Kuala Lumpur, the instant PRD-002's deferral criterion names. */
const ELEVEN_PM_KL_WED = "2029-08-15T15:00:00Z";

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Kill Switch SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Switched Sdn Bhd", "ap@switched.example", "2026-01-01T00:00:00.000Z")
    .run();
});

let capturedEvents: EventEnvelope[];
let llmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  capturedEvents = [];
  setEventSenderForTests(async (_env, envelope) => {
    capturedEvents.push(envelope);
  });
  llmMock = vi.fn();
  stubLlmProvider(llmMock);
});

afterEach(async () => {
  // Leave no pending DO alarm behind.
  //
  // Not hygiene for its own sake: `vi.setSystemTime` fakes `Date.now()` inside
  // the isolate, but miniflare schedules alarms on the real clock. An alarm set
  // for "faked now + 24h" that lands in the real past fires immediately, running
  // a second assessment concurrently with the test that scheduled it — extra
  // sends, extra events, and a Durable Object still writing storage while the
  // pool tries to snapshot it for the next test. The frozen clocks here are
  // pinned years ahead so that cannot happen; closing the loop as well means a
  // stray alarm has nothing left to do even if one slips through.
  //
  // Settling the invoices is the supported way to clear it: `onPaymentReceived`
  // is the one code path that calls `deleteAlarm()`, and it is what a real
  // payment does.
  await closeAgentLoop();
  setEventSenderForTests(null);
  setLlmProviderFactoryForTests(null);
  vi.useRealTimers();
});

// ---- helpers ---------------------------------------------------------------

function freeze(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

/** Only the fields a test cares about; everything else keeps its default. */
async function setAgentSettings(over: Record<string, number>): Promise<void> {
  const fields = Object.keys(over);
  await env.DB.prepare(
    `INSERT INTO agent_settings (tenant_id, ${fields.join(", ")})
     VALUES (?, ${fields.map(() => "?").join(", ")})
     ON CONFLICT (tenant_id) DO UPDATE SET
       ${fields.map((f) => `${f} = excluded.${f}`).join(", ")}`,
  )
    .bind(TENANT_ID, ...fields.map((f) => over[f]!))
    .run();
}

/** A window that is never shut, for the tests that are not about the window. */
const ALWAYS_OPEN = {
  contact_window_start_hour: 0,
  contact_window_end_hour: 24,
  suppress_weekends: 0,
  suppress_holidays: 0,
};

let invoiceSeq = 0;

async function createOverdueInvoice(dueDate: string, amountCents = 120_000): Promise<string> {
  const invoiceId = `inv_kill_${++invoiceSeq}`;
  await env.DB.prepare(
    `INSERT INTO invoices (invoice_id, tenant_id, customer_id, status, amount_due_cents, currency, due_date)
     VALUES (?, ?, ?, 'overdue', ?, 'MYR', ?)`,
  )
    .bind(invoiceId, TENANT_ID, CUSTOMER_ID, amountCents, dueDate)
    .run();
  return invoiceId;
}

function agentStub() {
  const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${CUSTOMER_ID}`);
  return env.COLLECTIONS_AGENT.get(id);
}

interface Snapshot {
  risk_score: number;
  escalation_stage: string;
  last_contact: string | null;
  reminder_history: { invoice_id: string }[];
  open_overdue_invoices: string[];
  deferred_until?: string | null;
  capped_invoices?: string[];
}

async function drive(invoiceId: string, amountCents = 120_000): Promise<void> {
  const stub = agentStub() as unknown as { onEvent(e: unknown): Promise<void> };
  await stub.onEvent(
    makeEnvelope({
      event_type: "invoice.overdue",
      source_module: "finance",
      tenant_id: TENANT_ID,
      payload: {
        invoice_id: invoiceId,
        customer_id: CUSTOMER_ID,
        amount_due_cents: amountCents,
        currency: "MYR",
        days_overdue: 30,
      },
    }),
  );
}

async function snapshot(): Promise<Snapshot | null> {
  return (agentStub() as unknown as { snapshot(): Promise<Snapshot | null> }).snapshot();
}

/**
 * Settle whatever the test left open, so the agent's loop closes and its alarm
 * is deleted. Failures here are swallowed on purpose: this is cleanup, and it
 * must never mask the assertion that actually failed.
 */
async function closeAgentLoop(): Promise<void> {
  try {
    const state = await snapshot();
    const stub = agentStub() as unknown as { onEvent(e: unknown): Promise<void> };
    for (const invoiceId of state?.open_overdue_invoices ?? []) {
      await stub.onEvent(
        makeEnvelope({
          event_type: "payment.received",
          source_module: "finance",
          tenant_id: TENANT_ID,
          payload: {
            invoice_id: invoiceId,
            customer_id: CUSTOMER_ID,
            amount_paid_cents: 120_000,
            currency: "MYR",
          },
        }),
      );
    }
  } catch {
    // cleanup only
  }
}

async function deliveries(): Promise<{ channel: string; status: string }[]> {
  const { results } = await env.DB.prepare(
    "SELECT channel, status FROM deliveries WHERE tenant_id = ? AND customer_id = ?",
  )
    .bind(TENANT_ID, CUSTOMER_ID)
    .all<{ channel: string; status: string }>();
  return results;
}

async function reminderActivities(): Promise<{ body: string | null }[]> {
  const { results } = await env.DB.prepare(
    "SELECT body FROM activities WHERE tenant_id = ? AND customer_id = ? AND kind = 'reminder_sent'",
  )
    .bind(TENANT_ID, CUSTOMER_ID)
    .all<{ body: string | null }>();
  return results;
}

function overrides(): EventEnvelope[] {
  return capturedEvents.filter((e) => e.event_type === "guardrail.override");
}

function decisions(): EventEnvelope[] {
  return capturedEvents.filter((e) => e.event_type === "collections.decision");
}

function remindCiting(invoiceId: string): CollectionsDecision {
  return {
    risk_score: 40,
    action: "remind",
    channel: "email",
    message: `Gentle reminder about invoice ${invoiceId}, MYR 1200.00.`,
  };
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ---- the kill switches ----------------------------------------------------

describe("the kill switches", () => {
  it("sends nothing for a paused customer, and still reschedules the alarm", async () => {
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2029-06-01");
    const patch = await gatewayFetch(`/v1/customers/${CUSTOMER_ID}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ agent_paused: true }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ agent_paused: true });

    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(0);
    expect(decisions()).toHaveLength(0);
    // Deliberately not audited as an override: a standing tenant instruction
    // re-checked daily would bury the override rate. See guard.ts.
    expect(overrides()).toHaveLength(0);
    // The loop survives — PRD-002's non-negotiable. Asserted as behaviour: the
    // invoice is still tracked, and the "resumes" test below shows the agent
    // picking it up again once the pause is lifted.
    expect((await snapshot())!.open_overdue_invoices).toEqual([invoiceId]);
  });

  it("sends nothing when the tenant disables agents, and still reschedules", async () => {
    freeze(NOON_KL_WED);
    await setAgentSettings({ enabled: 0 });
    const invoiceId = await createOverdueInvoice("2029-06-01");

    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(0);
    expect(decisions()).toHaveLength(0);
    expect(llmMock).not.toHaveBeenCalled();
    expect((await snapshot())!.open_overdue_invoices).toEqual([invoiceId]);
  });

  it("resumes the moment the tenant enables agents again", async () => {
    // The other half of "no send, but the loop is alive": nothing was lost while
    // the switch was off.
    freeze(NOON_KL_WED);
    await setAgentSettings({ enabled: 0 });
    const invoiceId = await createOverdueInvoice("2029-06-01");
    await drive(invoiceId);
    expect(await deliveries()).toHaveLength(0);

    await setAgentSettings({ enabled: 1 });
    freeze("2029-08-16T04:00:00Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(1);
  });

  it("resumes for a customer whose pause is lifted", async () => {
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2029-06-01");
    await env.DB.prepare("UPDATE customers SET agent_paused = 1 WHERE tenant_id = ? AND customer_id = ?")
      .bind(TENANT_ID, CUSTOMER_ID)
      .run();
    await drive(invoiceId);
    expect(await deliveries()).toHaveLength(0);

    await env.DB.prepare("UPDATE customers SET agent_paused = 0 WHERE tenant_id = ? AND customer_id = ?")
      .bind(TENANT_ID, CUSTOMER_ID)
      .run();
    freeze("2029-08-16T04:00:00Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(1);
  });

});

// ---- the per-invoice reminder cap -----------------------------------------

describe("the per-invoice reminder cap", () => {
  it("stops at the cap of 5 and does not send a 6th", async () => {
    await setAgentSettings({ ...ALWAYS_OPEN, max_reminders_per_invoice: 5 });
    const invoiceId = await createOverdueInvoice("2029-06-01");

    // Five reminders, a day apart so the 24h cooldown clears each time.
    for (let day = 0; day < 5; day++) {
      freeze(new Date(Date.parse(NOON_KL_WED) + day * 25 * 3_600_000).toISOString());
      llmMock.mockResolvedValue(remindCiting(invoiceId));
      await drive(invoiceId);
    }
    expect(await deliveries()).toHaveLength(5);
    expect(overrides()).toHaveLength(0);

    // The sixth attempt is refused.
    freeze(new Date(Date.parse(NOON_KL_WED) + 5 * 25 * 3_600_000).toISOString());
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(5);
    expect(llmMock).toHaveBeenCalledTimes(5); // the 6th never reached the model
    expect(overrides()).toHaveLength(1);
    expect(overrides()[0]!.payload).toMatchObject({
      guardrail: "reminder_cap",
      outcome: "suppressed",
      subject_ref: invoiceId,
    });
    expect(overrides()[0]!.payload.detail).toContain("cap is 5");
    // Still tracking the invoice: the cap stops the sending, not the watching.
    expect((await snapshot())!.open_overdue_invoices).toContain(invoiceId);
  });

  it("audits a capped invoice once, not once a day forever", async () => {
    await setAgentSettings({ ...ALWAYS_OPEN, max_reminders_per_invoice: 1 });
    const invoiceId = await createOverdueInvoice("2029-06-01");

    freeze(NOON_KL_WED);
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);

    for (let day = 1; day <= 3; day++) {
      freeze(new Date(Date.parse(NOON_KL_WED) + day * 25 * 3_600_000).toISOString());
      await drive(invoiceId);
    }

    expect(await deliveries()).toHaveLength(1);
    expect(overrides()).toHaveLength(1);
    expect((await snapshot())!.capped_invoices).toEqual([invoiceId]);
  });
});

// ---- bounds on the model's own words --------------------------------------

describe("what the model is allowed to say", () => {
  it("replaces a message citing an invoice that is not in context", async () => {
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2029-06-01");
    llmMock.mockResolvedValue({
      risk_score: 50,
      action: "remind",
      channel: "email",
      message: "Your invoice INV-9999 for MYR 40,000.00 is overdue. Please pay immediately.",
    });

    await drive(invoiceId);

    expect(overrides()).toHaveLength(1);
    expect(overrides()[0]!.payload).toMatchObject({
      guardrail: "invoice_reference",
      outcome: "message_replaced",
      from_action: "remind",
      to_action: "remind",
    });
    expect(overrides()[0]!.payload.detail).toContain("INV-9999");

    // The deterministic template went out instead, naming the real invoice —
    // and the hallucinated number is nowhere in it.
    const sent = decisions()[0]!.payload.message as string;
    expect(sent).toContain(invoiceId);
    expect(sent).not.toContain("INV-9999");
    expect(sent).toContain("Friendly reminder");
    expect(await deliveries()).toHaveLength(1);
  });

});

// ---- the fallback guarantee ------------------------------------------------

describe("nothing here stops collections", () => {
  it("falls back to Malaysian time when the tenant's timezone is unusable", async () => {
    await env.DB.prepare(
      `INSERT INTO company_profile (tenant_id, legal_name, timezone) VALUES (?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET timezone = excluded.timezone`,
    )
      .bind(TENANT_ID, "Switched Sdn Bhd", "Mars/Olympus_Mons")
      .run();
    const invoiceId = await createOverdueInvoice("2029-06-01");

    // Noon in Kuala Lumpur: the fallback zone is applied, so this sends.
    freeze(NOON_KL_WED);
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);
    expect(await deliveries()).toHaveLength(1);

    // And 23:00 Kuala Lumpur still defers — an unusable zone must not read as
    // "no window at all". The next evening, so the 24h cooldown is clear and the
    // window is the only thing that can be blocking.
    freeze("2029-08-16T15:00:00Z");
    await drive(invoiceId);
    expect(await deliveries()).toHaveLength(1);
    expect(overrides().some((e) => e.payload.guardrail === "contact_window")).toBe(true);
  });

  it("keeps sending in a year the shipped holiday calendar does not cover", async () => {
    // The calendar ships 2025–2027. A guard that read "no data" as "suppress"
    // would stop collections for a whole year, silently, in January.
    await setAgentSettings({
      contact_window_start_hour: 0,
      contact_window_end_hour: 24,
      suppress_weekends: 0,
      suppress_holidays: 1,
    });
    const invoiceId = await createOverdueInvoice("2029-06-01");

    freeze("2035-06-13T04:00:00Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(1);
    expect(overrides()).toHaveLength(0);
  });

  it("decides and sends with no LLM configured at all", async () => {
    setLlmProviderFactoryForTests(() => null);
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2029-06-01");

    await drive(invoiceId);

    expect(decisions()[0]!.payload).toMatchObject({ source: "fallback", action: "remind" });
    expect(await deliveries()).toHaveLength(1);
    // The deterministic template names a real invoice, so the reference guard
    // has nothing to correct.
    expect(overrides()).toHaveLength(0);
  });

  it("still sends after being blocked on every path in turn", async () => {
    // The non-negotiable, end to end: deferred out of hours, then switched off,
    // then switched back on — and the invoice is still chased. Asserted as
    // behaviour rather than by reading the DO's alarm, which is both a stronger
    // claim and the only way to make it without the storage read that
    // destabilises the pool's isolated-storage stack at 0.8.71.
    freeze(ELEVEN_PM_KL_WED);
    const invoiceId = await createOverdueInvoice("2029-06-01");
    await drive(invoiceId); // out of hours → deferred
    expect(await deliveries()).toHaveLength(0);

    await setAgentSettings({ enabled: 0 });
    freeze("2029-08-16T04:00:00Z");
    await drive(invoiceId); // agents off → nothing
    expect(await deliveries()).toHaveLength(0);

    await setAgentSettings({ enabled: 1 });
    freeze("2029-08-17T04:00:00Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId); // back on → the invoice is still there, and chased
    expect(await deliveries()).toHaveLength(1);
    expect((await snapshot())!.reminder_history).toHaveLength(1);
  });
});
