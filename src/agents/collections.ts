import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { makeEnvelope, type EventEnvelope } from "../schemas/envelope";
import { invoiceOverdueV2 } from "../schemas/events/invoice.overdue.v2";
import { paymentReceivedV2 } from "../schemas/events/payment.received.v2";
import { DeliveryError, sendReminder } from "../delivery/dispatch";
import { getLlmProvider } from "../llm";
import { insertActivityRow, getCustomer, getPaymentHistory } from "../modules/crm/service";
import { emitEvent } from "../queue/producer";
import { ensureEventBus } from "../queue/direct";
import {
  buildDecisionPrompt,
  collectionsDecisionSchema,
  DECISION_JSON_SCHEMA,
  DECISION_SYSTEM_PROMPT,
  fallbackDecision,
  MAX_MESSAGE_CHARS,
  type CollectionsContext,
  type CollectionsDecision,
  type OverdueInvoiceContext,
} from "./decision";

interface AgentState {
  tenant_id: string;
  customer_id: string;
  last_contact: string | null;
  risk_score: number;
  reminder_history: { invoice_id: string; sent_at: string; delivery_ref: string }[];
  escalation_stage: "none" | "reminded" | "escalated";
  open_overdue_invoices: string[];
}

const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily re-check while invoices stay open
// Never contact the same customer more than once per 24h, no matter how many
// overdue events arrive (the sweep re-emits daily by design).
const CONTACT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LLM_MAX_TOKENS = 8192;

/**
 * CollectionsAgent — one Durable Object per (tenant, customer), addressed by
 * idFromName(`${tenant_id}:${customer_id}`). Per-tenant state isolation for
 * free; no cross-tenant data bleed.
 *
 * Phase 2: every assessment gathers cross-module context from D1, asks the
 * configured LLM (src/llm/ — provider-agnostic) for a structured decision,
 * validates it with Zod, and falls back to the Phase 1 heuristic + template
 * on any failure — collections never silently stops. Every decision is
 * audited as a collections.decision.v1 event; escalation emits
 * customer.risk_flagged.v1.
 */
export class CollectionsAgent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    // The DO receives its own env from the runtime, so it needs the same
    // queue-less fallback the Worker entry points apply (docs/queue-send.md):
    // its audit events (collections.decision, customer.risk_flagged) must
    // still flow when no EVENTS queue binding exists.
    super(ctx, ensureEventBus(env));
  }

  private async getState(): Promise<AgentState | null> {
    return (await this.ctx.storage.get<AgentState>("state")) ?? null;
  }

  private async putState(state: AgentState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  /** Entry point: the queue consumer forwards validated envelopes here. */
  async onEvent(envelope: EventEnvelope): Promise<void> {
    console.log(
      `[CollectionsAgent] ${envelope.tenant_id} received ${envelope.event_type} (${envelope.event_id}, trace ${envelope.trace_id})`,
    );
    switch (envelope.event_type) {
      case "invoice.overdue":
        return this.onInvoiceOverdue(envelope);
      case "payment.received":
        return this.onPaymentReceived(envelope);
      default:
        // Registry should prevent this; log rather than throw so the queue
        // batch isn't retried for an event we simply don't handle.
        console.warn(`[CollectionsAgent] unhandled event_type ${envelope.event_type}`);
    }
  }

  private async onInvoiceOverdue(envelope: EventEnvelope): Promise<void> {
    const payload = invoiceOverdueV2.parse(envelope.payload);

    const state: AgentState = (await this.getState()) ?? {
      tenant_id: envelope.tenant_id,
      customer_id: payload.customer_id,
      last_contact: null,
      risk_score: 0,
      reminder_history: [],
      escalation_stage: "none",
      open_overdue_invoices: [],
    };
    if (!state.open_overdue_invoices.includes(payload.invoice_id)) {
      state.open_overdue_invoices.push(payload.invoice_id);
    }

    await this.assess(state, "event");

    // Re-check daily while anything stays unpaid.
    await this.ctx.storage.setAlarm(Date.now() + RECHECK_INTERVAL_MS);
  }

  private async onPaymentReceived(envelope: EventEnvelope): Promise<void> {
    const payload = paymentReceivedV2.parse(envelope.payload);
    const state = await this.getState();
    if (!state) return;

    state.open_overdue_invoices = state.open_overdue_invoices.filter(
      (id) => id !== payload.invoice_id,
    );
    if (state.open_overdue_invoices.length === 0) {
      // Loop closed: reset and stop re-checking.
      state.risk_score = 0;
      state.escalation_stage = "none";
      await this.ctx.storage.deleteAlarm();
    }
    await this.putState(state);
  }

  /**
   * Daily re-check: nagging frequency is a decision, not a side effect of
   * the sweep. Re-runs the full assessment unless the customer was
   * contacted within the last 24h.
   */
  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state || state.open_overdue_invoices.length === 0) return;
    await this.assess(state, "alarm");
    await this.ctx.storage.setAlarm(Date.now() + RECHECK_INTERVAL_MS);
  }

  /** One assessment: cooldown gate → context → decision → act. */
  private async assess(state: AgentState, trigger: "event" | "alarm"): Promise<void> {
    const now = Date.now();
    if (state.last_contact && now - Date.parse(state.last_contact) < CONTACT_COOLDOWN_MS) {
      console.log(
        `[CollectionsAgent] ${state.tenant_id}:${state.customer_id} contacted <24h ago, skipping (${trigger})`,
      );
      await this.putState(state);
      return;
    }

    const context = await this.assembleContext(state);
    if (context.overdue_invoices.length === 0) {
      // Nothing actually due (e.g. paid between the event and now).
      await this.putState(state);
      return;
    }

    const { decision, source } = await this.decide(context, state);
    decision.message = decision.message.slice(0, MAX_MESSAGE_CHARS);

    // Audit every decision — LLM or fallback — into events_log.
    await emitEvent(
      this.env,
      makeEnvelope({
        event_type: "collections.decision",
        source_module: "finance",
        tenant_id: state.tenant_id,
        payload: { customer_id: state.customer_id, ...decision, source, trigger },
      }),
    );

    state.risk_score = decision.risk_score;

    if (decision.action === "wait") {
      await this.putState(state);
      return;
    }

    // remind | escalate → send the composed message through the delivery port.
    const invoiceId = context.overdue_invoices[0]!.invoice_id;
    let deliveryRef: string | null = null;
    let usedChannel = decision.channel;
    try {
      const sent = await sendReminder(this.env, state.tenant_id, {
        invoice_id: invoiceId,
        customer_id: state.customer_id,
        channel: decision.channel,
        message: decision.message,
      });
      deliveryRef = sent.delivery_ref;
      usedChannel = sent.channel;
    } catch (err) {
      if (!(err instanceof DeliveryError)) throw err;
      // Undeliverable (no address / provider down): keep tracking and
      // re-checking, but don't record a contact that never happened.
      console.warn(
        `[CollectionsAgent] reminder undeliverable for ${state.tenant_id}:${state.customer_id}: ${err.message}`,
      );
      await this.putState(state);
      return;
    }

    // Collections history is CRM-visible: every reminder lands in the activities log.
    await insertActivityRow(this.env.DB, state.tenant_id, {
      customer_id: state.customer_id,
      kind: "reminder_sent",
      body: `${decision.action === "escalate" ? "escalation notice" : "reminder"} for invoice ${invoiceId} via ${usedChannel} (${deliveryRef})`,
    });

    const nowIso = new Date().toISOString();
    state.last_contact = nowIso;
    state.reminder_history.push({ invoice_id: invoiceId, sent_at: nowIso, delivery_ref: deliveryRef });

    if (decision.action === "escalate") {
      // Emit customer.risk_flagged only on the transition into `escalated`.
      if (state.escalation_stage !== "escalated") {
        await emitEvent(
          this.env,
          makeEnvelope({
            event_type: "customer.risk_flagged",
            source_module: "finance",
            tenant_id: state.tenant_id,
            payload: {
              customer_id: state.customer_id,
              risk_score: decision.risk_score,
              open_invoices: context.overdue_invoices.map((i) => i.invoice_id),
              total_due_cents: context.overdue_invoices.reduce(
                (sum, i) => sum + i.amount_due_cents,
                0,
              ),
            },
          }),
        );
      }
      state.escalation_stage = "escalated";
    } else if (state.escalation_stage === "none") {
      state.escalation_stage = "reminded";
    }

    await this.putState(state);
  }

  /** LLM decision with Zod validation; any failure falls back to the template. */
  private async decide(
    context: CollectionsContext,
    state: AgentState,
  ): Promise<{ decision: CollectionsDecision; source: "llm" | "fallback" }> {
    const stateSummary = {
      escalation_stage: state.escalation_stage,
      reminders_sent: state.reminder_history.length,
      last_contact: state.last_contact,
    };
    const provider = getLlmProvider(this.env);
    if (provider) {
      try {
        const raw = await provider.completeStructured({
          system: DECISION_SYSTEM_PROMPT,
          prompt: buildDecisionPrompt(context, stateSummary),
          schema: DECISION_JSON_SCHEMA,
          max_tokens: LLM_MAX_TOKENS,
        });
        return { decision: collectionsDecisionSchema.parse(raw), source: "llm" };
      } catch (err) {
        console.warn(
          `[CollectionsAgent] ${provider.name} decision failed, using fallback: ${String(err)}`,
        );
      }
    }
    return { decision: fallbackDecision(context, stateSummary), source: "fallback" };
  }

  /** Everything one database makes cheap: the cross-module customer picture. */
  private async assembleContext(state: AgentState): Promise<CollectionsContext> {
    const db = this.env.DB;
    const tenantId = state.tenant_id;
    const customerId = state.customer_id;
    const now = Date.now();

    const customer = await getCustomer(db, tenantId, customerId);

    const { results: invoiceRows } = await db
      .prepare(
        `SELECT invoice_id, amount_due_cents, currency, due_date FROM invoices
         WHERE tenant_id = ? AND customer_id = ? AND status IN ('overdue', 'partially_paid')
           AND amount_due_cents > 0
         ORDER BY due_date`,
      )
      .bind(tenantId, customerId)
      .all<{ invoice_id: string; amount_due_cents: number; currency: string; due_date: string }>();
    const overdue_invoices: OverdueInvoiceContext[] = invoiceRows
      .filter((r) => Date.parse(r.due_date) < now)
      .map((r) => ({
        ...r,
        days_overdue: Math.max(0, Math.floor((now - Date.parse(r.due_date)) / 86_400_000)),
      }));

    const recent_payments = (await getPaymentHistory(db, tenantId, customerId)).slice(-5);

    const { results: recent_activities } = await db
      .prepare(
        `SELECT kind, body, occurred_at FROM activities
         WHERE tenant_id = ? AND customer_id = ?
         ORDER BY occurred_at DESC LIMIT 10`,
      )
      .bind(tenantId, customerId)
      .all<{ kind: string; body: string | null; occurred_at: string }>();

    const { results: open_deals } = await db
      .prepare(
        `SELECT title, value_cents, currency FROM deals
         WHERE tenant_id = ? AND customer_id = ? AND status = 'open'`,
      )
      .bind(tenantId, customerId)
      .all<{ title: string; value_cents: number; currency: string }>();

    return { customer, overdue_invoices, recent_payments, recent_activities, open_deals };
  }

  /** Read-only snapshot for debugging/insights. */
  async snapshot(): Promise<AgentState | null> {
    return this.getState();
  }
}
