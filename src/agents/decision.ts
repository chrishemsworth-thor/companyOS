import { z } from "zod";
import type { PaymentHistoryEntry } from "../modules/crm/types";

/**
 * The CollectionsAgent's decision contract: what the LLM must return, the
 * JSON Schema we constrain it with, the prompt that produces it, and the
 * deterministic fallback used when no LLM is configured or the call fails.
 */

export const MAX_MESSAGE_CHARS = 2000;

export const collectionsDecisionSchema = z.object({
  risk_score: z.number().int().min(0).max(100),
  action: z.enum(["remind", "escalate", "wait"]),
  channel: z.enum(["email", "whatsapp"]),
  message: z.string().min(1),
});
export type CollectionsDecision = z.infer<typeof collectionsDecisionSchema>;

/** Structured-output schema (providers require additionalProperties:false + full required). */
export const DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    risk_score: {
      type: "integer",
      description: "Collection risk from 0 (will certainly pay) to 100 (likely write-off).",
    },
    action: {
      type: "string",
      enum: ["remind", "escalate", "wait"],
      description:
        "remind: send the composed message. escalate: send a firm final notice and flag the customer to the business owner. wait: contact now would hurt the relationship more than it helps.",
    },
    channel: { type: "string", enum: ["email", "whatsapp"] },
    message: {
      type: "string",
      description: "The exact reminder text to send to the customer. Empty only makes sense for action=wait, but always provide a draft.",
    },
  },
  required: ["risk_score", "action", "channel", "message"],
  additionalProperties: false,
};

export interface OverdueInvoiceContext {
  invoice_id: string;
  amount_due_cents: number;
  currency: string;
  due_date: string;
  days_overdue: number;
}

export interface CollectionsContext {
  customer: { customer_id: string; name: string; email: string | null; phone: string | null } | null;
  overdue_invoices: OverdueInvoiceContext[];
  recent_payments: PaymentHistoryEntry[];
  recent_activities: { kind: string; body: string | null; occurred_at: string }[];
  open_deals: { title: string; value_cents: number; currency: string }[];
}

export interface AgentStateSummary {
  escalation_stage: "none" | "reminded" | "escalated";
  reminders_sent: number;
  last_contact: string | null;
}

export const DECISION_SYSTEM_PROMPT = `You are the collections agent for a small business running on CompanyOS. You decide how to chase overdue invoices while protecting the customer relationship.

Rules:
- First contact is friendly and assumes good faith; repeat contact is firmer and more specific.
- Recommend "escalate" only after reminders have been ignored or the exposure is serious; escalation sends a firm final notice and flags the customer to the business owner.
- Recommend "wait" when contacting now would do more harm than good (e.g. payment just received days ago, or contact was very recent).
- A customer with a significant open deal in the pipeline gets a gentler tone — do not burn a live sale over a small overdue amount.
- State amounts with their currency exactly as given. Never invent invoice numbers, amounts, or dates.
- Keep the message under 150 words, plain text, no subject line, signed off as "the accounts team".`;

export function buildDecisionPrompt(
  context: CollectionsContext,
  state: AgentStateSummary,
): string {
  const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;
  const lines: string[] = [];

  const c = context.customer;
  lines.push(`Customer: ${c ? c.name : "unknown"} (${c?.customer_id ?? "?"})`);
  lines.push(
    `Collection history: escalation stage ${state.escalation_stage}, ${state.reminders_sent} reminder(s) sent, last contact ${state.last_contact ?? "never"}.`,
  );

  lines.push(`\nOverdue invoices (${context.overdue_invoices.length}):`);
  for (const inv of context.overdue_invoices) {
    lines.push(
      `- ${inv.invoice_id}: ${money(inv.amount_due_cents, inv.currency)}, due ${inv.due_date}, ${inv.days_overdue} day(s) overdue`,
    );
  }

  if (context.recent_payments.length > 0) {
    lines.push(`\nRecent payments:`);
    for (const p of context.recent_payments) {
      lines.push(`- ${money(p.applied_cents, p.currency)} on ${p.received_at} (invoice ${p.invoice_id})`);
    }
  } else {
    lines.push(`\nNo payment history on record.`);
  }

  if (context.recent_activities.length > 0) {
    lines.push(`\nRecent activity log:`);
    for (const a of context.recent_activities) {
      lines.push(`- [${a.occurred_at}] ${a.kind}${a.body ? `: ${a.body}` : ""}`);
    }
  }

  if (context.open_deals.length > 0) {
    lines.push(`\nOpen deals in the sales pipeline:`);
    for (const d of context.open_deals) {
      lines.push(`- ${d.title}: ${money(d.value_cents, d.currency)}`);
    }
  }

  lines.push(
    `\nAssess the collection risk and decide the next action. Compose the message you would send.`,
  );
  return lines.join("\n");
}

/**
 * Deterministic fallback: the Phase 1 heuristic and template, kept so
 * collections never silently stops when the LLM is unconfigured or down.
 */
export function fallbackDecision(
  context: CollectionsContext,
  state: AgentStateSummary,
): CollectionsDecision {
  if (context.overdue_invoices.length === 0) {
    return { risk_score: 0, action: "wait", channel: "email", message: "(nothing due)" };
  }
  const maxDays = Math.max(...context.overdue_invoices.map((i) => i.days_overdue));
  const risk_score = Math.min(100, maxDays * 5 + state.reminders_sent * 10);
  const action =
    state.escalation_stage !== "none" && state.reminders_sent >= 2 ? "escalate" : "remind";
  const inv = context.overdue_invoices[0]!;
  const message =
    action === "escalate"
      ? `Final notice: invoice ${inv.invoice_id} for ${inv.currency} ${(inv.amount_due_cents / 100).toFixed(2)} is ${inv.days_overdue} day(s) overdue despite previous reminders. Please arrange payment immediately to avoid further action.`
      : `Friendly reminder: invoice ${inv.invoice_id} for ${inv.currency} ${(inv.amount_due_cents / 100).toFixed(2)} is ${inv.days_overdue} day(s) overdue.`;
  return { risk_score, action, channel: "email", message };
}
