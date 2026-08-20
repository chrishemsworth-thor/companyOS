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
export const PROMPT_VERSION = "collections-2026-08-20";

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

/**
 * How this customer pays, as facts rather than a verdict.
 *
 * Both numbers are already computed by `getCustomerSignals` (PRD-003) on the
 * one query the agent's context assembly already makes — they were being thrown
 * away. They are the only inputs that say anything about *reliability* as
 * opposed to *lateness*, and keeping them as numbers (rather than passing S8's
 * health band) matters twice over:
 *
 *  1. **The band would double-count.** `computeHealth` derives `at_risk` partly
 *     FROM overdue invoices, so weighting a days-overdue score by the band
 *     would multiply the same fact by itself and a reliable customer with one
 *     very late invoice would still read as high risk.
 *  2. **DSO against the customer's OWN terms is the honest comparison.** A
 *     customer on 60-day terms paying in 55 days is paying on time, and S8
 *     already resolves those terms the same way invoice due dates do.
 */
export interface PaymentReliability {
  /**
   * Mean days from issue to payment over settled invoices. **Null means nothing
   * has ever been settled** — which is not the same as "pays badly", and the
   * scoring below is careful about the difference.
   */
  dso_days: number | null;
  /** The customer's own terms; `dso_days` is judged against these. */
  payment_terms_days: number;
}

export interface CollectionsContext {
  customer: { customer_id: string; name: string; email: string | null; phone: string | null } | null;
  billing_contact: BillingContactContext | null;
  /**
   * Null only when there is no customer record at all. Consumed by the
   * deterministic risk score and shown to the model, so both weigh a reliable
   * payer differently from an unknown one.
   */
  payment_reliability: PaymentReliability | null;
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
- Weigh the payment record, not just the days overdue. A customer who has always settled within terms being late once is a low risk with a probable explanation; a customer who has never settled anything is a high risk at the same number of days. In Malaysia, paying 60-90 days after invoice is common and is not by itself alarming.
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

  // How they pay, separately from how late this invoice is. The model sees the
  // same two facts the deterministic score weighs, and for the same reason:
  // "60 days late from a customer who always pays" and "60 days late from a
  // customer who has never paid" are not the same situation, and a risk score
  // that cannot tell them apart is not worth reporting.
  if (context.payment_reliability) {
    const { dso_days, payment_terms_days } = context.payment_reliability;
    lines.push(
      dso_days === null
        ? `\nPayment record: nothing settled yet; terms are ${payment_terms_days} days.`
        : `\nPayment record: settles in ${Math.round(dso_days)} days on average against ${payment_terms_days}-day terms.`,
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
 * How a customer pays, as one word. Ordered least to most worrying, except
 * `unproven`, which sits in the middle on purpose: we know nothing, and
 * "unknown" must not read as "bad".
 */
export type ReliabilityBand =
  /** Settles within its own terms. */
  | "always_pays"
  /** Settles a little late — inside the tolerance S8 already uses. */
  | "pays_late"
  /** Always late, always pays. The Malaysian SME norm, and not a write-off. */
  | "chronically_late"
  /** Nothing settled yet, and not enough time to judge. A new customer. */
  | "unproven"
  /** Invoiced, given a full cycle plus tolerance, and has settled nothing. */
  | "never_paid";

/**
 * How much the payment record moves the score, as a multiplier on the
 * lateness-and-persistence subtotal.
 *
 * A multiplier rather than an addition so reliability *scales* the concern
 * instead of cancelling it: a customer who has always paid, 90 days late, still
 * scores meaningfully above zero — being reliable is a reason to chase politely,
 * not a reason to ignore the money.
 *
 * The numbers are uncalibrated against real Malaysian SME behaviour and are
 * meant to be argued with; they are named here so the argument has something to
 * point at, and `evals/` is how a change to them gets checked.
 */
export const RELIABILITY_FACTORS: Record<ReliabilityBand, number> = {
  always_pays: 0.55,
  pays_late: 0.75,
  chronically_late: 0.9,
  unproven: 1,
  never_paid: 1.25,
};

/**
 * The same 15-day grace S8's health module allows before calling somebody a
 * slow payer. One tolerance, one place to change it.
 */
const DSO_TOLERANCE_DAYS = 15;

export function reliabilityBand(
  reliability: PaymentReliability | null,
  maxDaysOverdue: number,
): ReliabilityBand {
  // No customer record at all (the degenerate context): judge nothing.
  if (!reliability) return "unproven";
  const { dso_days, payment_terms_days } = reliability;
  const tolerance = payment_terms_days + DSO_TOLERANCE_DAYS;

  if (dso_days === null) {
    // Never settled anything. Whether that is damning depends on whether they
    // have HAD the chance: a customer whose first invoice is a week late is
    // unproven, not delinquent.
    return maxDaysOverdue > tolerance ? "never_paid" : "unproven";
  }
  if (dso_days <= payment_terms_days) return "always_pays";
  if (dso_days <= tolerance) return "pays_late";
  return "chronically_late";
}

/**
 * Days-overdue → points, on a curve rather than a straight line.
 *
 * The old formula was `days * 5`, which hit the 100 ceiling at 20 days and made
 * every invoice past three weeks look identical — a 20-day-late invoice from a
 * reliable customer scored the same as a 200-day write-off. The breakpoints
 * below are shaped to Malaysian SME reality, where **60–90 days late is common
 * and not by itself alarming**, and they stop at 55 so lateness alone can never
 * produce a maximum score.
 */
const LATENESS_CURVE: readonly [days: number, points: number][] = [
  [0, 0],
  [7, 5],
  [30, 20],
  [60, 30],
  [90, 40],
  [180, 50],
  [365, 55],
];

export function latenessPoints(daysOverdue: number): number {
  const days = Math.max(0, daysOverdue);
  const last = LATENESS_CURVE[LATENESS_CURVE.length - 1]!;
  if (days >= last[0]) return last[1];
  for (let i = 1; i < LATENESS_CURVE.length; i++) {
    const [upperDays, upperPoints] = LATENESS_CURVE[i]!;
    if (days > upperDays) continue;
    const [lowerDays, lowerPoints] = LATENESS_CURVE[i - 1]!;
    const span = upperDays - lowerDays;
    const progress = span === 0 ? 0 : (days - lowerDays) / span;
    return lowerPoints + progress * (upperPoints - lowerPoints);
  }
  return last[1];
}

/**
 * Reminders about *this* invoice that went unanswered. Ignored contact is the
 * strongest evidence available to a heuristic — it is the customer's own
 * behaviour in response to us, rather than an inference about them.
 */
const PERSISTENCE_POINTS: readonly number[] = [0, 7, 13, 20];

export function persistencePoints(remindersSent: number): number {
  const i = Math.max(0, Math.min(remindersSent, PERSISTENCE_POINTS.length - 1));
  return PERSISTENCE_POINTS[i]!;
}

export interface RiskAssessment {
  score: number;
  band: ReliabilityBand;
  /** The components, so a surprising score can be explained rather than argued with. */
  lateness: number;
  persistence: number;
  factor: number;
}

/**
 * The deterministic risk score: how late, how ignored, weighted by how this
 * customer actually pays.
 *
 * **Exposure is deliberately absent.** Amount owed obviously belongs in a risk
 * judgement, but invoices carry their own currency and this context can hold
 * several; scoring MYR 5,000 and SGD 5,000 as the same number would be worse
 * than leaving money out until there is a base-currency conversion to do it
 * properly. The model, which sees the amounts and the currencies, can and does
 * weigh them — this is the floor beneath it, not a replacement for it.
 */
export function assessRisk(
  context: CollectionsContext,
  state: AgentStateSummary,
): RiskAssessment {
  const maxDays = context.overdue_invoices.reduce((max, i) => Math.max(max, i.days_overdue), 0);
  const band = reliabilityBand(context.payment_reliability, maxDays);
  const factor = RELIABILITY_FACTORS[band];
  const lateness = latenessPoints(maxDays);
  const persistence = persistencePoints(state.reminders_sent);
  // Floored at 1 while anything is overdue. Rounding a reliable customer one day
  // late down to 0 would say "will certainly pay" — and 0 is more useful as the
  // reserved value for "nothing is due at all".
  const raw = Math.round((lateness + persistence) * factor);
  const score = Math.min(100, Math.max(context.overdue_invoices.length > 0 ? 1 : 0, raw));
  return { score, band, lateness, persistence, factor };
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
  const action =
    state.escalation_stage !== "none" && state.reminders_sent >= 2 ? "escalate" : "remind";
  return {
    risk_score: assessRisk(context, state).score,
    action,
    channel: "email",
    message: templateMessage(context, action),
  };
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
