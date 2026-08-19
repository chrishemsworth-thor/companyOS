import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { makeEnvelope, type EventEnvelope } from "../schemas/envelope";
import { invoiceOverdueV2 } from "../schemas/events/invoice.overdue.v2";
import { paymentReceivedV2 } from "../schemas/events/payment.received.v2";
import { DeliveryError, sendReminder } from "../delivery/dispatch";
import { getLlmProvider } from "../llm";
import { insertActivityRow, getCustomer, getPaymentHistory } from "../modules/crm/service";
import { resolveContact } from "../modules/crm/contact-roles";
import { getCustomerSignals } from "../modules/crm/signals";
import { computeHealth } from "../modules/crm/health";
import { emitEvent } from "../queue/producer";
import { ensureEventBus } from "../queue/direct";
import {
  decideCollections,
  templateMessage,
  type AgentStateSummary,
  type DecisionOutcome,
  type BillingContactContext,
  type CollectionsContext,
  type OverdueInvoiceContext,
} from "./decision";
import {
  applyDecisionGuards,
  loadAgentPolicy,
  loadHolidayLookup,
  preflight,
  type GuardrailOverrideRecord,
  type PreflightResult,
  type SendContext,
} from "./guardrails";

interface AgentState {
  tenant_id: string;
  customer_id: string;
  last_contact: string | null;
  risk_score: number;
  reminder_history: { invoice_id: string; sent_at: string; delivery_ref: string }[];
  escalation_stage: "none" | "reminded" | "escalated";
  open_overdue_invoices: string[];
  /**
   * When a guardrail deferred a send (out of hours, weekend, public holiday).
   * PRD-002 requires deferral rather than dropping, so this is also what the
   * alarm is set to — the send happens when the window opens.
   */
  deferred_until?: string | null;
  /**
   * Invoices whose reminder cap has already been audited. The cap is a terminal
   * state — every daily re-check hits it again — so the override event fires
   * once per invoice instead of once a day forever.
   */
  capped_invoices?: string[];
}

const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily re-check while invoices stay open
const LLM_MAX_TOKENS = 8192;
/**
 * PRD-002: "Escalation requires: invoice past due by >= tenant threshold AND
 * >= 2 prior reminders." The days half is `escalation_threshold_days` in
 * `agent_settings` (tenant-configurable, default 60); this half is not
 * configurable, because a tenant lowering it to zero would be a tenant turning
 * the guardrail off, and PRD-002 wants first contact to be un-escalatable by
 * construction.
 */
const MIN_REMINDERS_BEFORE_ESCALATION = 2;

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

    // The alarm time comes back from the assessment: a guardrail deferral needs
    // the DO awake when the contact window opens, not in 24 hours.
    const { next_alarm_at } = await this.assess(state, "event");
    await this.ctx.storage.setAlarm(next_alarm_at);
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
    const { next_alarm_at } = await this.assess(state, "alarm");
    await this.ctx.storage.setAlarm(next_alarm_at);
  }

  /**
   * When to wake up next. The routine daily re-check, unless a guardrail said
   * "try again at" sooner — a send deferred out of the night lands at 09:00,
   * not tomorrow evening.
   *
   * **The alarm is never cleared by a guardrail.** That is the fallback
   * guarantee in one line: whatever a guard decides about one send, the agent
   * keeps looking. Only a closed loop (every invoice paid, in
   * `onPaymentReceived`) stops the re-check.
   */
  private nextAlarm(now: number, retryAt: number | null): number {
    const routine = now + RECHECK_INTERVAL_MS;
    const candidate = retryAt === null ? routine : Math.min(retryAt, routine);
    // Never schedule in the past: a stale retry_at would spin the DO.
    return Math.max(candidate, now + 1_000);
  }

  /** One `guardrail.override.v1` per firing (PRD-002: "the override is
   * logged"). Agent-agnostic payload — see SESSION-PLAN C9. */
  private async emitOverrides(
    tenantId: string,
    overrides: readonly GuardrailOverrideRecord[],
  ): Promise<void> {
    for (const override of overrides) {
      await emitEvent(
        this.env,
        makeEnvelope({
          event_type: "guardrail.override",
          source_module: "finance",
          tenant_id: tenantId,
          payload: { ...override },
        }),
      );
    }
  }

  /**
   * One assessment: policy → guardrail preflight → context → decision →
   * decision guards → act.
   *
   * The guardrails (PRD-002 P0) are enforced here, in code, at two points. The
   * split is not cosmetic: the kill switches, the cooldown, the per-invoice cap
   * and the contact window do not depend on what the model would say, so they
   * run first and the tokens are never spent; the bounds on the model's own
   * output — it cannot escalate early, cite an invoice it was not shown, or
   * write past the character cap — can only run after it answers.
   *
   * Returns when the DO should wake next. Nothing in this method can stop the
   * agent's loop; that is the fallback guarantee.
   */
  private async assess(
    state: AgentState,
    trigger: "event" | "alarm",
  ): Promise<{ next_alarm_at: number }> {
    const now = Date.now();
    // Neither of these throws: an unreadable policy resolves to the
    // conservative Malaysian defaults and missing holiday data reads as "no
    // holidays". A guard that threw here would be a silent stop.
    const policy = await loadAgentPolicy(this.env.DB, state.tenant_id);
    const holidays = await loadHolidayLookup(this.env.DB, state.tenant_id, policy.timezone, now);

    // Pass 1 — the checks that need no cross-module context. This is what keeps
    // a 2am wake, or a customer contacted an hour ago, down to two queries.
    const baseCtx: SendContext = {
      agent: "collections",
      subject_type: "customer",
      subject_id: state.customer_id,
      channel: "email",
      at: now,
      last_contact_at: state.last_contact ? Date.parse(state.last_contact) : null,
      paused: false,
      sends_for_ref: 0,
      ref: null,
    };
    const early = preflight(policy, baseCtx, holidays);
    if (!early.allow) return this.blocked(state, early, trigger, now);

    const { context, paused } = await this.assembleContext(state);
    if (context.overdue_invoices.length === 0) {
      // Nothing actually due (e.g. paid between the event and now).
      await this.putState(state);
      return { next_alarm_at: this.nextAlarm(now, null) };
    }

    // Pass 2 — the same guard, now knowing which invoice this send is about and
    // whether a human has paused this customer. The window and cooldown cannot
    // have changed since pass 1 (same instant), so nothing is audited twice.
    const target = context.overdue_invoices[0]!;
    const sendsForTarget = state.reminder_history.filter(
      (r) => r.invoice_id === target.invoice_id,
    ).length;
    const ctx: SendContext = {
      ...baseCtx,
      paused,
      sends_for_ref: sendsForTarget,
      ref: target.invoice_id,
    };
    const gate = preflight(policy, ctx, holidays);
    if (!gate.allow) return this.blocked(state, gate, trigger, now);

    const stateSummary = {
      escalation_stage: state.escalation_stage,
      reminders_sent: state.reminder_history.length,
      last_contact: state.last_contact,
    };
    const outcome = await this.decide(context, stateSummary);
    const proposed = outcome.decision;

    const { decision, overrides } = applyDecisionGuards(
      policy,
      { ...ctx, channel: proposed.channel },
      proposed,
      {
        valid_refs: context.overdue_invoices.map((i) => i.invoice_id),
        // The deterministic template, for whichever action the guard settles
        // on. PRD-002: "the deterministic template is sent instead".
        fallback_message: (action) =>
          templateMessage(context, action as "remind" | "escalate" | "wait"),
        escalation: {
          action: "escalate",
          downgrade_to: "remind",
          days_past_due: Math.max(...context.overdue_invoices.map((i) => i.days_overdue)),
          // Reminders about THIS invoice, not every reminder this customer has
          // ever had. Escalation is about one debt, and letting chases of other
          // invoices count towards it is how a customer gets a final notice on
          // an invoice they have been reminded about once.
          prior_sends: sendsForTarget,
          min_prior_sends: MIN_REMINDERS_BEFORE_ESCALATION,
        },
      },
    );
    if (overrides.length > 0) await this.emitOverrides(state.tenant_id, overrides);

    // Audit every decision — LLM or fallback — into events_log.
    await emitEvent(
      this.env,
      makeEnvelope({
        event_type: "collections.decision",
        source_module: "finance",
        tenant_id: state.tenant_id,
        payload: {
          customer_id: state.customer_id,
          ...decision,
          source: outcome.source,
          trigger,
          // PRD-003 P0: "the fallback is recorded on the decision". Optional
          // additions to a non-strict collections.decision.v1 — no v2 needed.
          // S10 folds these into collections.decision.v2 along with the
          // provider/model/cost fields PRD-002 wants.
          contact_id: context.billing_contact?.contact_id ?? null,
          contact_match: context.billing_contact?.matched ?? null,
        },
      }),
    );

    state.risk_score = decision.risk_score;
    state.deferred_until = null;

    if (decision.action === "wait") {
      await this.putState(state);
      return { next_alarm_at: this.nextAlarm(now, null) };
    }

    // remind | escalate → send the composed message through the delivery port.
    const invoiceId = target.invoice_id;
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
      return { next_alarm_at: this.nextAlarm(now, null) };
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
    return { next_alarm_at: this.nextAlarm(now, null) };
  }

  /**
   * A guardrail stopped this send. Record it, keep the loop alive, and say when
   * to try again.
   *
   * The reminder cap is audited once per invoice rather than once per re-check:
   * it is a terminal state, so every daily wake would otherwise write another
   * `guardrail.override.v1` for the same fact, for as long as the invoice stays
   * open.
   */
  private async blocked(
    state: AgentState,
    result: Extract<PreflightResult, { allow: false }>,
    trigger: "event" | "alarm",
    now: number,
  ): Promise<{ next_alarm_at: number }> {
    console.log(
      `[CollectionsAgent] ${state.tenant_id}:${state.customer_id} not contacted — ${result.guardrail}: ${result.detail} (${trigger})`,
    );
    state.deferred_until =
      result.guardrail === "contact_window" && result.retry_at !== null
        ? new Date(result.retry_at).toISOString()
        : null;

    let override = result.override;
    if (override?.guardrail === "reminder_cap" && override.subject_ref) {
      const capped = state.capped_invoices ?? [];
      if (capped.includes(override.subject_ref)) {
        override = null;
      } else {
        state.capped_invoices = [...capped, override.subject_ref];
      }
    }
    if (override) await this.emitOverrides(state.tenant_id, [override]);

    await this.putState(state);
    return { next_alarm_at: this.nextAlarm(now, result.retry_at) };
  }

  /**
   * The decision, through the shared decision function — the same one
   * `npm run eval` runs. PRD-002's whole premise is that a model or prompt
   * change can be evaluated before it ships, and an eval that exercised a copy
   * of this logic would be measuring the copy.
   */
  private async decide(
    context: CollectionsContext,
    stateSummary: AgentStateSummary,
  ): Promise<DecisionOutcome> {
    return decideCollections(getLlmProvider(this.env), context, stateSummary, {
      price_env: this.env,
      max_tokens: LLM_MAX_TOKENS,
    });
  }

  /**
   * Everything one database makes cheap: the cross-module customer picture.
   *
   * `agent_paused` comes back beside the context rather than inside it: it is a
   * guardrail input, and the context is what the model is shown. The model has
   * no business knowing it was nearly muzzled.
   */
  private async assembleContext(
    state: AgentState,
  ): Promise<{ context: CollectionsContext; paused: boolean }> {
    const db = this.env.DB;
    const tenantId = state.tenant_id;
    const customerId = state.customer_id;
    const now = Date.now();

    const customer = await getCustomer(db, tenantId, customerId);

    // Who the reminder will reach (PRD-003). Resolved here as well as inside
    // sendReminder because the decision is audited BEFORE the send — including
    // for action=wait, which never sends at all — and the audit has to say who
    // the agent was targeting.
    const resolved = await resolveContact(db, tenantId, customerId, "billing");
    const billing_contact: BillingContactContext | null = resolved && {
      contact_id: resolved.contact.contact_id,
      name: resolved.contact.name,
      title: resolved.contact.title,
      email: resolved.contact.email,
      phone: resolved.contact.phone,
      matched: resolved.matched,
    };

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

    // Derived health (PRD-003), one query. A signal for the model's tone, never
    // a gate on whether to send — see modules/crm/health.ts for why.
    const signals = await getCustomerSignals(db, tenantId, customerId);
    const computed = computeHealth(signals);
    const health = {
      band: computed.band,
      reasons: computed.reasons.map((r) => r.detail),
    };

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

    return {
      context: {
        customer,
        billing_contact,
        health,
        overdue_invoices,
        recent_payments,
        recent_activities,
        open_deals,
      },
      paused: customer?.agent_paused ?? false,
    };
  }

  /** Read-only snapshot for debugging/insights. */
  async snapshot(): Promise<AgentState | null> {
    return this.getState();
  }
}
