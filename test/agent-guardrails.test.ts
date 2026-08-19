import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope, type EventEnvelope } from "../src/schemas/envelope";
import { validatePayload } from "../src/schemas/events/registry";
import { setLlmProviderFactoryForTests } from "../src/llm";
import { setEventSenderForTests } from "../src/queue/producer";
import type { CollectionsAgent } from "../src/agents/collections";
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
 */

const API_KEY = "test_api_key_guardrails";
const TENANT_ID = "biz_guard";
const CUSTOMER_ID = "cust_guard_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

/** Noon in Kuala Lumpur on a working day — the uncontroversial instant. */
const NOON_KL_WED = "2026-08-19T04:00:00Z";
/** 23:00 in Kuala Lumpur, the instant PRD-002's deferral criterion names. */
const ELEVEN_PM_KL_WED = "2026-08-19T15:00:00Z";

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
  setLlmProviderFactoryForTests(() => ({ name: "anthropic", completeStructured: llmMock }));
});

afterEach(() => {
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

/** The DO's alarm, read from its own storage — the proof that the agent's loop
 * survived whatever the guard just did. */
async function alarmAt(): Promise<number | null> {
  return runInDurableObject(
    agentStub() as unknown as DurableObjectStub<CollectionsAgent>,
    async (_instance, state) => state.storage.getAlarm(),
  );
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
    const invoiceId = await createOverdueInvoice("2026-08-17"); // 2 days overdue
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

    expect(decisions()[0]!.payload).toMatchObject({ action: "remind" });
    // No escalation side effects: no risk flag, and the stage stays `reminded`.
    expect(capturedEvents.filter((e) => e.event_type === "customer.risk_flagged")).toHaveLength(0);
    expect((await snapshot())!.escalation_stage).toBe("reminded");
    expect(await reminderActivities()).toHaveLength(1);
    expect((await reminderActivities())[0]!.body).toContain("reminder for invoice");
  });

  it("blocks escalation on a long-overdue invoice that has had only one reminder", async () => {
    freeze(NOON_KL_WED);
    await setAgentSettings(ALWAYS_OPEN);
    const invoiceId = await createOverdueInvoice("2020-01-01"); // years overdue
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId); // reminder 1

    freeze("2026-08-20T04:00:01Z");
    llmMock.mockResolvedValue({
      risk_score: 99,
      action: "escalate",
      channel: "email",
      message: `Final notice for invoice ${invoiceId}.`,
    });
    await drive(invoiceId);

    // Past due by a mile, but one prior reminder is not two.
    expect(overrides()).toHaveLength(1);
    expect(overrides()[0]!.payload).toMatchObject({
      guardrail: "escalation_gate",
      outcome: "downgraded",
    });
    expect(overrides()[0]!.payload.detail).toContain("1 prior reminder(s), minimum 2");
    expect((await snapshot())!.escalation_stage).toBe("reminded");
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
    freeze("2026-08-20T04:00:01Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);
  }

  it("holds a 46-day-overdue escalation at the 60-day default", async () => {
    // 2026-07-06 → 46 days by 21 August.
    const invoiceId = await createOverdueInvoice("2026-07-06");
    await remindTwice(invoiceId);

    freeze("2026-08-21T04:00:02Z");
    llmMock.mockResolvedValue({
      risk_score: 88,
      action: "escalate",
      channel: "email",
      message: `Final notice for invoice ${invoiceId}.`,
    });
    await drive(invoiceId);

    const gate = overrides().filter((e) => e.payload.guardrail === "escalation_gate");
    expect(gate).toHaveLength(1);
    expect(gate[0]!.payload.detail).toContain("46 day(s) past due, threshold 60");
    expect(gate[0]!.payload.detail).not.toContain("prior reminder");
    expect((await snapshot())!.escalation_stage).toBe("reminded");
  });

  it("permits the same escalation once the tenant lowers the threshold to 30", async () => {
    const invoiceId = await createOverdueInvoice("2026-07-06");
    await remindTwice(invoiceId);
    await setAgentSettings({ escalation_threshold_days: 30 });

    freeze("2026-08-21T04:00:02Z");
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
    const invoiceId = await createOverdueInvoice("2026-06-01");

    await drive(invoiceId);

    // Nothing was sent, and nothing was decided — the guard runs before the
    // model, so a 2am wake does not even spend tokens.
    expect(await deliveries()).toHaveLength(0);
    expect(await reminderActivities()).toHaveLength(0);
    expect(decisions()).toHaveLength(0);
    expect(llmMock).not.toHaveBeenCalled();

    // It was deferred to 09:00 tenant local (01:00Z), and the DO is awake then.
    expect(overrides()).toHaveLength(1);
    expect(overrides()[0]!.payload).toMatchObject({
      guardrail: "contact_window",
      outcome: "deferred",
      defer_until: "2026-08-20T01:00:00.000Z",
    });
    expect((await snapshot())!.deferred_until).toBe("2026-08-20T01:00:00.000Z");
    expect(await alarmAt()).toBe(Date.parse("2026-08-20T01:00:00.000Z"));

    // And the invoice is still tracked: deferral is not forgetting.
    expect((await snapshot())!.open_overdue_invoices).toEqual([invoiceId]);
  });

  it("sends when the deferred-to window opens", async () => {
    freeze(ELEVEN_PM_KL_WED);
    const invoiceId = await createOverdueInvoice("2026-06-01");
    await drive(invoiceId);
    expect(await deliveries()).toHaveLength(0);

    // 09:00 the next morning: the same invoice, now contactable.
    freeze("2026-08-20T01:00:00Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(1);
    expect((await snapshot())!.deferred_until).toBeNull();
  });

  it("defers a Saturday over the weekend, and over the holidays that follow it", async () => {
    // Monday 24 August is a tenant-declared national holiday; Tuesday 25 is
    // Maulidur Rasul in the shipped calendar. So Saturday defers to Wednesday.
    await env.DB.prepare(
      `INSERT INTO public_holidays (holiday_id, tenant_id, holiday_date, name, scope, observed)
       VALUES (?, ?, '2026-08-24', 'Company shutdown day', 'national', 1)`,
    )
      .bind("hol_guard_1", TENANT_ID)
      .run();

    freeze("2026-08-22T04:00:00Z"); // Saturday noon KL
    const invoiceId = await createOverdueInvoice("2026-06-01");
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(0);
    expect(overrides()[0]!.payload).toMatchObject({
      guardrail: "contact_window",
      outcome: "deferred",
      defer_until: "2026-08-26T01:00:00.000Z",
    });
    expect(overrides()[0]!.payload.detail).toContain("non_working_day");
    // The send waits for Wednesday, but the agent does not: the alarm is the
    // routine daily re-check, which is sooner. A deferral moves the alarm
    // EARLIER when the window opens sooner than that — never later, and never
    // away.
    const alarm = await alarmAt();
    expect(alarm).toBe(Date.parse("2026-08-22T04:00:00Z") + 24 * 3_600_000);
    expect(alarm!).toBeLessThan(Date.parse("2026-08-26T01:00:00.000Z"));
  });

  it("contacts on a Saturday for a tenant that turns weekend suppression off", async () => {
    await setAgentSettings({ suppress_weekends: 0 });
    freeze("2026-08-22T04:00:00Z");
    const invoiceId = await createOverdueInvoice("2026-06-01");
    llmMock.mockResolvedValue(remindCiting(invoiceId));

    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(1);
    expect(overrides()).toHaveLength(0);
  });
});

// ---- the kill switches ----------------------------------------------------

describe("the kill switches", () => {
  it("sends nothing for a paused customer, and still reschedules the alarm", async () => {
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2026-06-01");
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
    // The loop survives — PRD-002's non-negotiable.
    expect(await alarmAt()).toBe(Date.parse(NOON_KL_WED) + 24 * 3_600_000);
    expect((await snapshot())!.open_overdue_invoices).toEqual([invoiceId]);
  });

  it("sends nothing when the tenant disables agents, and still reschedules", async () => {
    freeze(NOON_KL_WED);
    await setAgentSettings({ enabled: 0 });
    const invoiceId = await createOverdueInvoice("2026-06-01");

    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(0);
    expect(decisions()).toHaveLength(0);
    expect(llmMock).not.toHaveBeenCalled();
    expect(await alarmAt()).toBe(Date.parse(NOON_KL_WED) + 24 * 3_600_000);
  });

  it("resumes for a customer whose pause is lifted", async () => {
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2026-06-01");
    await env.DB.prepare("UPDATE customers SET agent_paused = 1 WHERE tenant_id = ? AND customer_id = ?")
      .bind(TENANT_ID, CUSTOMER_ID)
      .run();
    await drive(invoiceId);
    expect(await deliveries()).toHaveLength(0);

    await gatewayFetch(`/v1/customers/${CUSTOMER_ID}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ agent_paused: false }),
    });
    freeze("2026-08-20T04:00:00Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(1);
  });
});

// ---- the per-invoice reminder cap -----------------------------------------

describe("the per-invoice reminder cap", () => {
  it("stops at the cap of 5 and does not send a 6th", async () => {
    await setAgentSettings({ ...ALWAYS_OPEN, max_reminders_per_invoice: 5 });
    const invoiceId = await createOverdueInvoice("2026-06-01");

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
    // Still tracking, still waking up.
    expect(await alarmAt()).not.toBeNull();
  });

  it("audits a capped invoice once, not once a day forever", async () => {
    await setAgentSettings({ ...ALWAYS_OPEN, max_reminders_per_invoice: 1 });
    const invoiceId = await createOverdueInvoice("2026-06-01");

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
    const invoiceId = await createOverdueInvoice("2026-06-01");
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

  it("replaces a message that names no invoice at all", async () => {
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2026-06-01");
    llmMock.mockResolvedValue({
      risk_score: 50,
      action: "remind",
      channel: "email",
      message: "Hi there — just a nudge about your outstanding balance. Thanks!",
    });

    await drive(invoiceId);

    expect(overrides()[0]!.payload).toMatchObject({
      guardrail: "invoice_reference",
      outcome: "message_replaced",
    });
    expect(overrides()[0]!.payload.detail).toContain("no invoice from the context");
    expect(decisions()[0]!.payload.message).toContain(invoiceId);
  });

  it("leaves a message naming a real invoice alone", async () => {
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2026-06-01");
    llmMock.mockResolvedValue(remindCiting(invoiceId));

    await drive(invoiceId);

    expect(overrides()).toHaveLength(0);
    expect(decisions()[0]!.payload.message).toBe(remindCiting(invoiceId).message);
  });

  it("truncates a message past the tenant's character cap", async () => {
    freeze(NOON_KL_WED);
    await setAgentSettings({ max_message_chars: 500 });
    const invoiceId = await createOverdueInvoice("2026-06-01");
    const long = `Invoice ${invoiceId} is overdue. ${"Please pay. ".repeat(500)}`;
    llmMock.mockResolvedValue({
      risk_score: 50,
      action: "remind",
      channel: "email",
      message: long,
    });

    await drive(invoiceId);

    expect(overrides()).toHaveLength(1);
    expect(overrides()[0]!.payload).toMatchObject({
      guardrail: "message_length",
      outcome: "truncated",
    });
    expect(overrides()[0]!.payload.detail).toContain("cap 500");
    expect((decisions()[0]!.payload.message as string).length).toBe(500);
  });

  it("does not police the wording of a `wait` — nothing is sent either way", async () => {
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2026-06-01");
    llmMock.mockResolvedValue({
      risk_score: 10,
      action: "wait",
      channel: "email",
      message: "(draft) leave them alone for now",
    });

    await drive(invoiceId);

    expect(overrides()).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
    expect(decisions()[0]!.payload).toMatchObject({ action: "wait" });
  });
});

// ---- the fallback guarantee ------------------------------------------------

describe("nothing here stops collections", () => {
  it("falls back to Malaysian time when the tenant's timezone is unusable", async () => {
    await env.DB.prepare(
      `INSERT INTO company_profile (tenant_id, legal_name, timezone) VALUES (?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET timezone = excluded.timezone`,
    )
      .bind(TENANT_ID, "Guarded Sdn Bhd", "Mars/Olympus_Mons")
      .run();
    const invoiceId = await createOverdueInvoice("2026-06-01");

    // Noon in Kuala Lumpur: the fallback zone is applied, so this sends.
    freeze(NOON_KL_WED);
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);
    expect(await deliveries()).toHaveLength(1);

    // And 23:00 Kuala Lumpur still defers — an unusable zone must not read as
    // "no window at all".
    freeze("2026-08-20T15:00:00Z");
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
    const invoiceId = await createOverdueInvoice("2026-06-01");

    freeze("2035-06-13T04:00:00Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId);

    expect(await deliveries()).toHaveLength(1);
    expect(overrides()).toHaveLength(0);
  });

  it("decides and sends with no LLM configured at all", async () => {
    setLlmProviderFactoryForTests(() => null);
    freeze(NOON_KL_WED);
    const invoiceId = await createOverdueInvoice("2026-06-01");

    await drive(invoiceId);

    expect(decisions()[0]!.payload).toMatchObject({ source: "fallback", action: "remind" });
    expect(await deliveries()).toHaveLength(1);
    // The deterministic template names a real invoice, so the reference guard
    // has nothing to correct.
    expect(overrides()).toHaveLength(0);
  });

  it("keeps the alarm alive through a guardrail block on every path", async () => {
    freeze(ELEVEN_PM_KL_WED);
    const invoiceId = await createOverdueInvoice("2026-06-01");
    await drive(invoiceId); // deferred
    expect(await alarmAt()).not.toBeNull();

    await setAgentSettings({ enabled: 0 });
    freeze("2026-08-20T04:00:00Z");
    await drive(invoiceId); // disabled
    expect(await alarmAt()).not.toBeNull();

    await setAgentSettings({ enabled: 1, ...ALWAYS_OPEN, max_reminders_per_invoice: 1 });
    freeze("2026-08-21T04:00:00Z");
    llmMock.mockResolvedValue(remindCiting(invoiceId));
    await drive(invoiceId); // sends
    freeze("2026-08-22T04:00:00Z");
    await drive(invoiceId); // capped
    expect(await alarmAt()).not.toBeNull();
  });
});
