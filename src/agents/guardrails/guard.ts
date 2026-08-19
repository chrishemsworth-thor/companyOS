import type { AgentPolicy } from "./policy";
import { contactWindow, NO_HOLIDAYS, type HolidayLookup } from "./window";

/**
 * The shared guard. PRD-002 P0: hard bounds "enforced in code, not by prompt
 * instructions the model may ignore".
 *
 * Two evaluation points, because the rules split cleanly:
 *
 * - `preflight()` runs BEFORE the model is asked. Kill switches, cooldown, the
 *   per-invoice cap and the contact window do not depend on what the model
 *   would say, so checking them first also saves the tokens.
 * - `applyDecisionGuards()` runs AFTER the model returns and before any send.
 *   These are the bounds on the model's own output: it cannot escalate early,
 *   cannot cite an invoice that is not in front of it, and cannot write past
 *   the character cap.
 *
 * **Inputs are agent-shaped, not invoice-shaped** (SESSION-PLAN C9): "this
 * send, to this subject, on this channel, for this tenant", with references as
 * opaque strings and the escalation rule passed in rather than hardcoded. S15
 * owns making the guard fully agent-agnostic; this is the part that was free.
 */

export type GuardrailKind =
  | "agents_disabled"
  | "subject_paused"
  | "contact_cooldown"
  | "contact_window"
  | "reminder_cap"
  | "escalation_gate"
  | "invoice_reference"
  | "message_length";

export type GuardrailOutcome =
  | "suppressed"
  | "deferred"
  | "downgraded"
  | "message_replaced"
  | "truncated";

/** One guardrail firing, in the shape `guardrail.override.v1` records. */
export interface GuardrailOverrideRecord {
  agent: string;
  subject_type: "customer";
  subject_id: string;
  channel: "email" | "whatsapp";
  guardrail: GuardrailKind;
  outcome: GuardrailOutcome;
  from_action: string | null;
  to_action: string | null;
  /** The thing the send was about — an invoice today, a deal for S15. */
  subject_ref: string | null;
  detail: string;
  /** ISO timestamp the send was deferred to, for `outcome: "deferred"`. */
  defer_until: string | null;
}

export interface SendContext {
  /** "collections" today; S15's sales agent passes its own name. */
  agent: string;
  subject_type: "customer";
  subject_id: string;
  channel: "email" | "whatsapp";
  /** The instant being evaluated, epoch ms. Injected, never `Date.now()` here,
   * so the guard is testable and the eval harness can freeze it. */
  at: number;
  /** Last outbound contact to this subject, epoch ms; null if never. */
  last_contact_at: number | null;
  /** The per-subject half of the kill switch (`customers.agent_paused`). */
  paused: boolean;
  /** Sends already made for `ref` — the per-invoice reminder count. */
  sends_for_ref: number;
  ref: string | null;
}

export type PreflightResult =
  | { allow: true; window_open_at: number }
  | {
      allow: false;
      guardrail: GuardrailKind;
      /** When to try again. Null means "not on a timer" — a paused customer or
       * a capped invoice needs a human or a payment, not a later alarm. The
       * caller still reschedules its routine re-check either way: nothing here
       * is allowed to end the agent's loop. */
      retry_at: number | null;
      /** Null when this firing is deliberately not audited — see below. */
      override: GuardrailOverrideRecord | null;
      detail: string;
    };

function record(
  ctx: SendContext,
  fields: Pick<GuardrailOverrideRecord, "guardrail" | "outcome" | "detail"> &
    Partial<GuardrailOverrideRecord>,
): GuardrailOverrideRecord {
  return {
    agent: ctx.agent,
    subject_type: ctx.subject_type,
    subject_id: ctx.subject_id,
    channel: ctx.channel,
    from_action: null,
    to_action: null,
    subject_ref: ctx.ref,
    defer_until: null,
    ...fields,
  };
}

/**
 * May this send happen at all, right now?
 *
 * **What is deliberately not audited.** `agents_disabled`, `subject_paused` and
 * `contact_cooldown` return `override: null`. They are standing tenant
 * instructions rather than the guard correcting the agent, and the overdue
 * sweep re-emits daily — an event per check would write a row to `events_log`
 * every day for every paused customer, and drag PRD-002's override *rate* (a
 * quality signal about the prompt, held to < 10%) towards 100%. The window
 * deferral and the reminder cap DO produce records: those are the guard
 * changing an outcome the agent was otherwise going to reach.
 */
export function preflight(
  policy: AgentPolicy,
  ctx: SendContext,
  holidays: HolidayLookup = NO_HOLIDAYS,
): PreflightResult {
  if (!policy.enabled) {
    return {
      allow: false,
      guardrail: "agents_disabled",
      retry_at: null,
      override: null,
      detail: "agents disabled for this tenant",
    };
  }
  if (ctx.paused) {
    return {
      allow: false,
      guardrail: "subject_paused",
      retry_at: null,
      override: null,
      detail: `agent paused for ${ctx.subject_id}`,
    };
  }

  const cooldownMs = policy.contact_cooldown_hours * 3_600_000;
  if (ctx.last_contact_at !== null && ctx.at - ctx.last_contact_at < cooldownMs) {
    return {
      allow: false,
      guardrail: "contact_cooldown",
      retry_at: ctx.last_contact_at + cooldownMs,
      override: null,
      detail: `contacted within ${policy.contact_cooldown_hours}h`,
    };
  }

  if (ctx.sends_for_ref >= policy.max_reminders_per_invoice) {
    return {
      allow: false,
      guardrail: "reminder_cap",
      retry_at: null,
      override: record(ctx, {
        guardrail: "reminder_cap",
        outcome: "suppressed",
        detail: `${ctx.sends_for_ref} reminder(s) already sent for ${ctx.ref ?? "this reference"}, cap is ${policy.max_reminders_per_invoice}`,
      }),
      detail: `reminder cap ${policy.max_reminders_per_invoice} reached`,
    };
  }

  const window = contactWindow(policy, ctx.at, holidays);
  if (!window.open) {
    return {
      allow: false,
      guardrail: "contact_window",
      retry_at: window.next_open_at,
      override: record(ctx, {
        guardrail: "contact_window",
        outcome: "deferred",
        detail: `outside the contact window (${window.reason}${window.detail ? `: ${window.detail}` : ""})`,
        defer_until: new Date(window.next_open_at).toISOString(),
      }),
      detail: `contact window shut (${window.reason})`,
    };
  }

  return { allow: true, window_open_at: window.next_open_at };
}

/** The minimum a decision must look like for the guard to bound it. */
export interface GuardableDecision {
  action: string;
  channel: "email" | "whatsapp";
  message: string;
}

export interface EscalationRule {
  /** The action that needs the gate — "escalate" for collections. */
  action: string;
  /** What it becomes when the gate is not met. */
  downgrade_to: string;
  /** Days past due on the thing being chased. */
  days_past_due: number;
  /** Prior contacts about it. */
  prior_sends: number;
  /** PRD-002: escalation needs BOTH the threshold and this many reminders. */
  min_prior_sends: number;
}

export interface DecisionGuardOptions {
  /** References that genuinely exist in the context the model was given. */
  valid_refs: readonly string[];
  /**
   * The deterministic text to substitute, for the action the guard settles on.
   * A function rather than a string because a downgrade changes the action, and
   * the replacement has to match: the words written to escalate must not go out
   * as a reminder. Supplied by the caller because only the caller owns its own
   * template.
   */
  fallback_message: (action: string) => string;
  /** Null when the decision has no escalation-shaped action. */
  escalation: EscalationRule | null;
}

/**
 * Anything that looks like an invoice reference. Real ids here are
 * `inv_<ULID>`; a hallucinated one is almost always `INV-1234`-shaped, and both
 * match. A tenant numbering scheme this misses (`2026/001`) simply yields no
 * candidates, so the check neither fires nor false-positives — it rejects
 * *invented-looking* references, which is what PRD-002 asks for.
 *
 * Separators are allowed inside the reference, not just after the prefix:
 * matching only up to the second separator would read `inv_acme_7` as a
 * citation of `inv_acme` and call a perfectly real invoice invented.
 */
const REF_PATTERN = /\binv[-_][A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*/gi;

export function referencedIds(message: string): string[] {
  return [...message.matchAll(REF_PATTERN)].map((m) => m[0]);
}

export interface DecisionGuardResult<D extends GuardableDecision> {
  decision: D;
  overrides: GuardrailOverrideRecord[];
}

/**
 * Bound the model's output. Every firing produces a record; the caller emits
 * one `guardrail.override.v1` per record and marks the decision as overridden.
 */
export function applyDecisionGuards<D extends GuardableDecision>(
  policy: AgentPolicy,
  ctx: SendContext,
  decision: D,
  opts: DecisionGuardOptions,
): DecisionGuardResult<D> {
  const overrides: GuardrailOverrideRecord[] = [];
  let guarded: D = { ...decision };

  // 1. The escalation gate. PRD-002: "The model cannot escalate earlier
  //    regardless of what it returns."
  const rule = opts.escalation;
  if (rule && guarded.action === rule.action) {
    const daysShort = rule.days_past_due < policy.escalation_threshold_days;
    const remindersShort = rule.prior_sends < rule.min_prior_sends;
    if (daysShort || remindersShort) {
      const why = [
        daysShort
          ? `${rule.days_past_due} day(s) past due, threshold ${policy.escalation_threshold_days}`
          : null,
        remindersShort
          ? `${rule.prior_sends} prior reminder(s), minimum ${rule.min_prior_sends}`
          : null,
      ]
        .filter(Boolean)
        .join("; ");
      overrides.push(
        record(ctx, {
          guardrail: "escalation_gate",
          outcome: "downgraded",
          from_action: rule.action,
          to_action: rule.downgrade_to,
          detail: `${why} (message replaced with the ${rule.downgrade_to} template)`,
        }),
      );
      // The message goes with the action. Downgrading `escalate` to `remind`
      // while sending the model's final-notice wording would be a downgrade in
      // the audit log only, and the customer would still be threatened.
      guarded = {
        ...guarded,
        action: rule.downgrade_to,
        message: opts.fallback_message(rule.downgrade_to),
      };
    }
  }

  // 2. Reference integrity. Only meaningful for a decision that sends: a
  //    `wait` carries a draft nobody reads.
  const sends = guarded.action !== "wait";
  if (sends && opts.valid_refs.length > 0) {
    const cited = referencedIds(guarded.message);
    const valid = new Set(opts.valid_refs.map((r) => r.toLowerCase()));
    const invented = cited.filter((c) => !valid.has(c.toLowerCase()));
    const citesReal = cited.some((c) => valid.has(c.toLowerCase()));
    if (invented.length > 0 || !citesReal) {
      overrides.push(
        record(ctx, {
          guardrail: "invoice_reference",
          outcome: "message_replaced",
          from_action: guarded.action,
          to_action: guarded.action,
          detail:
            invented.length > 0
              ? `message cites ${invented.join(", ")}, not in context`
              : "message cites no invoice from the context",
        }),
      );
      guarded = { ...guarded, message: opts.fallback_message(guarded.action) };
    }
  }

  // 3. The character cap, last, so it also bounds a substituted template.
  if (guarded.message.length > policy.max_message_chars) {
    overrides.push(
      record(ctx, {
        guardrail: "message_length",
        outcome: "truncated",
        from_action: guarded.action,
        to_action: guarded.action,
        detail: `${guarded.message.length} chars, cap ${policy.max_message_chars}`,
      }),
    );
    guarded = { ...guarded, message: guarded.message.slice(0, policy.max_message_chars) };
  }

  return { decision: guarded, overrides };
}
