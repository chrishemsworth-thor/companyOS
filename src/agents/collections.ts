import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { EventEnvelope } from "../schemas/envelope";
import { invoiceOverdueV2 } from "../schemas/events/invoice.overdue.v2";
import { paymentReceivedV2 } from "../schemas/events/payment.received.v2";
import { getDeliveryProvider } from "../delivery/console";

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

/**
 * CollectionsAgent — one Durable Object per (tenant, customer), addressed by
 * idFromName(`${tenant_id}:${customer_id}`). Per-tenant state isolation for
 * free; no cross-tenant data bleed.
 *
 * Phase 0 behavior is deliberately dumb: log the event, send one templated
 * reminder through the gateway's adapter, schedule a daily alarm re-check.
 * Phase 1 replaces `decideAction` with real agent intelligence.
 */
export class CollectionsAgent extends DurableObject<Env> {
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

    // Dumbest possible risk heuristic for Phase 0.
    state.risk_score = Math.min(100, payload.days_overdue * 5 + state.reminder_history.length * 10);

    const { delivery_ref } = await getDeliveryProvider().send({
      invoice_id: payload.invoice_id,
      customer_id: payload.customer_id,
      channel: "email",
      message: `Friendly reminder: invoice ${payload.invoice_id} for ${payload.currency} ${(payload.amount_due_cents / 100).toFixed(2)} is ${payload.days_overdue} day(s) overdue.`,
    });

    const now = new Date().toISOString();
    state.last_contact = now;
    state.escalation_stage = "reminded";
    state.reminder_history.push({ invoice_id: payload.invoice_id, sent_at: now, delivery_ref });
    if (!state.open_overdue_invoices.includes(payload.invoice_id)) {
      state.open_overdue_invoices.push(payload.invoice_id);
    }
    await this.putState(state);

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

  /** Scheduled re-check for stale invoices. Phase 0: log + re-arm. */
  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state || state.open_overdue_invoices.length === 0) return;
    console.log(
      `[CollectionsAgent] daily re-check for ${state.tenant_id}:${state.customer_id} — ${state.open_overdue_invoices.length} invoice(s) still overdue, risk ${state.risk_score}`,
    );
    // Phase 1: re-evaluate risk, escalate, emit customer.risk_flagged, etc.
    await this.ctx.storage.setAlarm(Date.now() + RECHECK_INTERVAL_MS);
  }

  /** Read-only snapshot for debugging/insights. */
  async snapshot(): Promise<AgentState | null> {
    return this.getState();
  }
}
