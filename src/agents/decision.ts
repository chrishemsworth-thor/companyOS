import { z } from "zod";
import type { PaymentHistoryEntry } from "../modules/crm/types";
import type { LlmProvider } from "../llm/types";
import { estimateCostMicros, type PriceOverride } from "../llm/pricing";

/**
 * The CollectionsAgent's decision contract: what the LLM must return, the
 * JSON Schema we constrain it with, the prompt that produces it, and the
 * deterministic fallback used when no LLM is configured or the call fails.
 */

/**
 * Default outbound message cap. The enforced value is
 * `agent_settings.max_message_chars` (tenant-configurable, same default) — this
 * constant is what that column defaults to and what the eval harness uses when
 * no tenant policy is in play.
 */
export const MAX_MESSAGE_CHARS = 2000;

/**
 * The prompt this build asks with. Every decision records it
 * (`collections.decision.v2`), so an eval baseline is tied to a prompt and a
 * behaviour change can be attributed to the prompt that caused it.
 *
 * **Bump this whenever DECISION_SYSTEM_PROMPT or buildDecisionPrompt changes**,
 * and add a line to the changelog in `evals/README.md`. A baseline captured
 * under one version says nothing about another.
 */
export const PROMPT_VERSION = "collections-2026-08-19";

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

/**
 * The person this reminder will actually reach (PRD-003). `matched` records
 * how the resolution chain got there: `role` means a real billing contact,
 * `primary`/`any` mean it fell back. Null when the customer has no contacts and
 * the customer-level address will be used.
 */
export interface BillingContactContext {
  contact_id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  matched: "role" | "primary" | "any";
}

export interface CollectionsContext {
  customer: { customer_id: string; name: string; email: string | null; phone: string | null } | null;
  billing_contact: BillingContactContext | null;
  /**
   * Derived health (PRD-003). Present in the context so the agent can reason
   * about the whole account rather than one invoice — **it is a signal, not a
   * gate.** Nothing in the send path reads `band` to decide whether to send;
   * that stays with PRD-002's guardrail layer. See modules/crm/health.ts.
   */
  health: { band: "good" | "watch" | "at_risk"; reasons: string[] } | null;
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
  // Naming the recipient is the point of PRD-003 contact roles: the message is
  // addressed to the person who controls payment rather than to the company.
  // The fallback wording matters — the model should not greet somebody by name
  // as "the billing contact" when it is really guessing.
  const contact = context.billing_contact;
  if (contact) {
    const who = contact.title ? `${contact.name}, ${contact.title}` : contact.name;
    lines.push(
      contact.matched === "role"
        ? `Recipient: ${who} — the customer's designated billing contact. Address the message to them by name.`
        : `Recipient: ${who} — NOT a designated billing contact (resolved by fallback: ${contact.matched}). Address them politely and do not assume they control payment.`,
    );
  } else {
    lines.push(
      `Recipient: no named contact on file; the message goes to the company's general address. Do not greet anybody by name.`,
    );
  }
  lines.push(
    `Collection history: escalation stage ${state.escalation_stage}, ${state.reminders_sent} reminder(s) sent, last contact ${state.last_contact ?? "never"}.`,
  );

  if (context.health) {
    // Tone input, not an instruction. The prompt deliberately does not say
    // "do not contact an at_risk customer" — auto-pausing on health was
    // decided against for v1 and the model must not implement it by proxy.
    lines.push(
      `\nAccount health: ${context.health.band}. ${context.health.reasons.join(" ")}`.trim(),
    );
  }

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
  return { risk_score, action, channel: "email", message: templateMessage(context, action) };
}

/**
 * The deterministic message for a given action, on the oldest overdue invoice.
 *
 * Split out of `fallbackDecision` because the guardrail layer needs it too, and
 * needs it **per action**: when the guard downgrades an escalation the model
 * wrote, the escalation's words cannot go out with it. A "final notice, legal
 * action will follow" sent as a friendly reminder is exactly the customer-
 * relationship damage the downgrade exists to prevent, so the guard swaps the
 * message for the one this composes for the action it settled on.
 */
export function templateMessage(
  context: CollectionsContext,
  action: "remind" | "escalate" | "wait",
): string {
  const inv = context.overdue_invoices[0];
  if (!inv) return "(nothing due)";
  const amount = `${inv.currency} ${(inv.amount_due_cents / 100).toFixed(2)}`;
  return action === "escalate"
    ? `Final notice: invoice ${inv.invoice_id} for ${amount} is ${inv.days_overdue} day(s) overdue despite previous reminders. Please arrange payment immediately to avoid further action.`
    : `Friendly reminder: invoice ${inv.invoice_id} for ${amount} is ${inv.days_overdue} day(s) overdue.`;
}


/**
 * One decision, with everything PRD-002 wants recorded about how it was
 * reached: provider, model, prompt version, tokens, latency and estimated cost,
 * and whether the deterministic fallback fired.
 *
 * This function — not the Durable Object's private method — is the collections
 * agent's decision function. The DO calls it and so does the eval harness, which
 * is the only way "run the scenario suite before switching models" can mean
 * anything: an eval that exercised a copy of the logic would measure the copy.
 */
export interface DecisionOutcome {
  decision: CollectionsDecision;
  source: "llm" | "fallback";
  provider: "anthropic" | "openai" | null;
  model: string | null;
  prompt_version: string;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  cost_micros: number | null;
  /** Present when the fallback fired: no provider, an API error, or bad output. */
  fallback_reason: string | null;
}

export interface DecideOptions {
  /** Override the system prompt — how the eval harness runs a broken prompt. */
  system?: string;
  /** Reads LLM_PRICE_* overrides for a model with no built-in rate. */
  price_env?: PriceOverride;
  max_tokens?: number;
}

const DEFAULT_MAX_TOKENS = 8192;

export async function decideCollections(
  provider: LlmProvider | null,
  context: CollectionsContext,
  state: AgentStateSummary,
  opts: DecideOptions = {},
): Promise<DecisionOutcome> {
  const started = Date.now();
  const base = {
    prompt_version: PROMPT_VERSION,
    input_tokens: null,
    output_tokens: null,
    cost_micros: null,
  };

  if (!provider) {
    return {
      ...base,
      decision: fallbackDecision(context, state),
      source: "fallback",
      provider: null,
      model: null,
      latency_ms: Date.now() - started,
      fallback_reason: "no_provider",
    };
  }

  try {
    const result = await provider.completeStructured({
      system: opts.system ?? DECISION_SYSTEM_PROMPT,
      prompt: buildDecisionPrompt(context, state),
      schema: DECISION_JSON_SCHEMA,
      max_tokens: opts.max_tokens ?? DEFAULT_MAX_TOKENS,
    });
    // Zod is the gate: a schema-shaped-but-wrong response (risk_score 900, an
    // action outside the enum) falls back rather than reaching the send path.
    const decision = collectionsDecisionSchema.parse(result.output);
    return {
      prompt_version: PROMPT_VERSION,
      decision,
      source: "llm",
      provider: provider.name,
      model: result.model,
      input_tokens: result.usage?.input_tokens ?? null,
      output_tokens: result.usage?.output_tokens ?? null,
      latency_ms: Date.now() - started,
      cost_micros: estimateCostMicros(result.model, result.usage, opts.price_env),
      fallback_reason: null,
    };
  } catch (err) {
    // The fallback guarantee: collections never silently stops, so every LLM
    // failure mode — network, refusal, unparseable JSON, schema violation —
    // lands on the deterministic heuristic and says so.
    console.warn(`[collections] ${provider.name} decision failed, using fallback: ${String(err)}`);
    return {
      ...base,
      decision: fallbackDecision(context, state),
      source: "fallback",
      provider: provider.name,
      model: null,
      latency_ms: Date.now() - started,
      fallback_reason: String(err).slice(0, 200),
    };
  }
}
