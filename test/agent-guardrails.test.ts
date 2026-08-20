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
 * PRD-002's P0 guardrails, through the real CollectionsAgent.
 *
 * Every acceptance criterion in the PRD's "Hard guardrails in code" section has
 * a test here, plus the tenant-configurable threshold and the fallback
 * guarantee. The clock is faked throughout: the guard's whole job is to know
 * what time it is where the tenant is, so a suite that let the wall clock
 * decide would pass or fail by the hour.
 *
 * Dates used: 2026-08-19 is a Wednesday; 22/23 August are the weekend; 24
 * August is a Melaka-only holiday (state scope — deliberately NOT suppressed,
 * the guard resolves the national scope) and 25 August is Maulidur Rasul, a
 * national holiday in the shipped calendar.
 *
 * **One integration test per mechanism.** What lives here needs a Durable
 * Object: the events, the alarm, the send, the settings coming out of D1. The
 * arithmetic and string handling — the escalation gate's two conditions,
 * reference integrity, the character cap — is asserted directly against
 * `applyDecisionGuards` in `test/agent-decision-guards.test.ts`, and the
 * timezone and window maths in `test/agent-guardrails-window.test.ts`. Driving a
 * DO to check a string length bought nothing but wall-clock, and a Durable
 * Object mid-write when the pool snapshots storage between tests is how this
 * suite used to fail intermittently.
 */

const API_KEY = "test_api_key_guardrails";
const TENANT_ID = "biz_guard";
const CUSTOMER_ID = "cust_guard_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

/**
 * Noon in Kuala Lumpur on a working day — the uncontroversial instant.
 *
 * **Why 2029 and not next Tuesday.** `vi.setSystemTime` fakes `Date.now()`
 * inside the isolate, but miniflare's alarm scheduler runs on the real clock. So
 * a frozen "now" in the real past makes every `setAlarm(now + 24h)` fire
 * immediately, which runs a second assessment concurrently with the test that
 * scheduled it — extra sends, extra events, and a Durable Object still writing
 * storage when the pool tries to snapshot it. A date pinned near the real today
 * is therefore a time bomb: it works until the calendar catches up with it.
 * Keeping the frozen clock years ahead means the alarm never fires during a run.
 */
const NOON_KL_WED = "2029-08-15T04:00:00Z";
/** 23:00 in Kuala Lumpur, the instant PRD-002's deferral criterion names. */
const ELEVEN_PM_KL_WED = "2029-08-15T15:00:00Z";

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Guardrail SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Guarded Sdn Bhd", "ap@guarded.example", "2026-01-01T00:00:00.000Z")
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
  const invoiceId = `inv_guard_${++invoiceSeq}`;
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

// ---- the escalation gate ---------------------------------------------------

describe("escalation is gated, whatever the model returns", () => {
  it("downgrades escalate → remind on a 2-day-overdue first contact and logs the override", async () => {
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2029-08-13"); // 2 days overdue
    llmMock.mockResolvedValue({
      risk_score: 95,
      action: "escalate",
      channel: "email",
      message: `Final notice for invoice ${invoiceId}. Legal action will follow.`,
    });

    await drive(invoiceId);

    // The send still happened — downgraded, not dropped.
    const override = overrides();
    expect(override).toHaveLength(1);
    expect(validatePayload("guardrail.override", override[0]!.payload)).toEqual({ ok: true });
    expect(override[0]!.payload).toMatchObject({
      agent: "collections",
      subject_type: "customer",
      subject_id: CUSTOMER_ID,
      guardrail: "escalation_gate",
      outcome: "downgraded",
      from_action: "escalate",
      to_action: "remind",
      subject_ref: invoiceId,
    });
    // Both halves of the gate are named in the detail, so support can see why.
    expect(override[0]!.payload.detail).toContain("2 day(s) past due, threshold 60");
    expect(override[0]!.payload.detail).toContain("0 prior reminder(s), minimum 2");
    expect(override[0]!.payload.detail).toContain("message replaced with the remind template");

    expect(decisions()[0]!.payload).toMatchObject({ action: "remind" });
    // The escalation's WORDS were replaced too. A downgrade that left "legal
    // action will follow" in the message would be a downgrade in the audit log
    // only, and the customer would still have been threatened over an invoice
    // two days late.
    const sent = decisions()[0]!.payload.message as string;
    expect(sent).not.toContain("Legal action");
    expect(sent).not.toContain("Final notice");
    expect(sent).toContain("Friendly reminder");
    expect(sent).toContain(invoiceId);
    // No escalation side effects: no risk flag, and the stage stays `reminded`.
    expect(capturedEvents.filter((e) => e.event_type === "customer.risk_flagged")).toHaveLength(0);
    expect((await snapshot())!.escalation_stage).toBe("reminded");
    expect(await reminderActivities()).toHaveLength(1);
    expect((await reminderActivities())[0]!.body).toContain("reminder for invoice");
  });

});

// ---- the tenant-configurable threshold ------------------------------------

describe("the escalation threshold is the tenant's to set", () => {
  /** Two reminders on the same invoice, a day apart, so the gate's
   * reminder-count half is satisfied and only the days half is in question. */
  async function remindTwice(invoiceId: string): Promise<void> {
    freeze(NOON_KL_WED);
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);
    freeze("2029-08-16T04:00:01Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);
  }

  it("permits the same escalation once the tenant lowers the threshold to 30", async () => {
    const invoiceId = await createOverdueInvoice("2029-07-02");
    await remindTwice(invoiceId);
    await setAgentSettings({ escalation_threshold_days: 30 });

    freeze("2029-08-17T04:00:02Z");
    llmMock.mockResolvedValue({
      risk_score: 88,
      action: "escalate",
      channel: "email",
      message: `Final notice for invoice ${invoiceId}.`,
    });
    await drive(invoiceId);

    expect(overrides().filter((e) => e.payload.guardrail === "escalation_gate")).toHaveLength(0);
    expect((await snapshot())!.escalation_stage).toBe("escalated");
    expect(capturedEvents.filter((e) => e.event_type === "customer.risk_flagged")).toHaveLength(1);
  });
});

// ---- the contact window ---------------------------------------------------

describe("the contact window defers, and never drops", () => {
  it("defers a 23:00 decision to 09:00 the next morning", async () => {
    freeze(ELEVEN_PM_KL_WED);
    const invoiceId = await createOverdueInvoice("2029-06-01");

    await drive(invoiceId);

    // Nothing was sent, and nothing was decided — the guard runs before the
    // model, so a 2am wake does not even spend tokens.
    expect(await deliveries()).toHaveLength(0);
    expect(await reminderActivities()).toHaveLength(0);
    expect(decisions()).toHaveLength(0);
    expect(llmMock).not.toHaveBeenCalled();

    // It was deferred to 09:00 tenant local (01:00Z) — recorded on the override
    // event and on the agent's own state.
    expect(overrides()).toHaveLength(1);
    expect(overrides()[0]!.payload).toMatchObject({
      guardrail: "contact_window",
      outcome: "deferred",
      defer_until: "2029-08-16T01:00:00.000Z",
    });
    expect((await snapshot())!.deferred_until).toBe("2029-08-16T01:00:00.000Z");

    // And the invoice is still tracked: deferral is not forgetting. The proof
    // that the send actually happens later is the next test — behaviour, rather
    // than an assertion about an alarm value.
    expect((await snapshot())!.open_overdue_invoices).toEqual([invoiceId]);
  });

  it("sends when the deferred-to window opens", async () => {
    freeze(ELEVEN_PM_KL_WED);
    const invoiceId = await createOverdueInvoice("2029-06-01");
    await drive(invoiceId);
    expect(await deliveries()).toHaveLength(0);

    // 09:00 the next morning: the same invoice, now contactable.
    freeze("2029-08-16T01:00:00Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(1);
    expect((await snapshot())!.deferred_until).toBeNull();
  });

  it("defers a Saturday over the weekend, and over the holidays that follow it", async () => {
    // Monday and Tuesday are both tenant-declared holidays, so Saturday defers
    // all the way to Wednesday — the whole run is skipped, not just the first
    // day of it. (S6's shipped calendar is exercised in
    // agent-guardrails-window.test.ts, which needs no Durable Object.)
    for (const [id, date] of [
      ["hol_guard_1", "2029-08-20"],
      ["hol_guard_2", "2029-08-21"],
    ]) {
      await env.DB.prepare(
        `INSERT INTO public_holidays (holiday_id, tenant_id, holiday_date, name, scope, observed)
         VALUES (?, ?, ?, 'Company shutdown day', 'national', 1)`,
      )
        .bind(id, TENANT_ID, date)
        .run();
    }

    freeze("2029-08-18T04:00:00Z"); // Saturday noon KL
    const invoiceId = await createOverdueInvoice("2029-06-01");
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(0);
    expect(overrides()[0]!.payload).toMatchObject({
      guardrail: "contact_window",
      outcome: "deferred",
      defer_until: "2029-08-22T01:00:00.000Z",
    });
    expect(overrides()[0]!.payload.detail).toContain("non_working_day");
    // The send waits for Wednesday; the invoice does not stop being tracked in
    // the meantime, and the agent's own daily re-check is sooner than the
    // deferral either way (nextAlarm takes the minimum of the two).
    expect((await snapshot())!.open_overdue_invoices).toEqual([invoiceId]);
    expect((await snapshot())!.deferred_until).toBe("2029-08-22T01:00:00.000Z");
  });
});

