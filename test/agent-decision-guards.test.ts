import { describe, it, expect } from "vitest";
import {
  applyDecisionGuards,
  DEFAULT_AGENT_POLICY,
  type AgentPolicy,
  type SendContext,
} from "../src/agents/guardrails";
import type { CollectionsDecision } from "../src/agents/decision";

/**
 * The bounds on the model's own output — `applyDecisionGuards`, directly.
 *
 * These run against the function rather than through the Durable Object on
 * purpose. What they assert is arithmetic and string handling: the escalation
 * gate's two conditions, whether a cited invoice exists, how long a message is.
 * None of it depends on D1, an alarm or a delivery, so driving a DO to check it
 * bought nothing but wall-clock — and, with
 * `@cloudflare/vitest-pool-workers@0.8.71`, DO-heavy suites intermittently trip
 * the pool's own isolated-storage stack (it copies each DO's SQLite file between
 * tests and refuses the `-shm` sidecar a resident object leaves behind).
 *
 * `test/agent-guardrails.test.ts` keeps one integration test per mechanism —
 * the wiring, the events, the alarm, the send — which is what needs a DO.
 */

const ctx = (over: Partial<SendContext> = {}): SendContext => ({
  agent: "collections",
  subject_type: "customer",
  subject_id: "cust_1",
  channel: "email",
  at: Date.parse("2026-08-19T04:00:00Z"),
  last_contact_at: null,
  paused: false,
  sends_for_ref: 0,
  ref: "inv_1",
  ...over,
});

const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  ...DEFAULT_AGENT_POLICY,
  ...over,
});

const decision = (over: Partial<CollectionsDecision> = {}): CollectionsDecision => ({
  risk_score: 50,
  action: "remind",
  channel: "email",
  message: "Gentle reminder about invoice inv_1.",
  ...over,
});

/** The caller's deterministic template, per action. */
const template = (action: string) =>
  action === "escalate"
    ? "Final notice: invoice inv_1 is overdue despite previous reminders."
    : "Friendly reminder: invoice inv_1 is overdue.";

const guardOpts = (over: Partial<Parameters<typeof applyDecisionGuards>[3]> = {}) => ({
  valid_refs: ["inv_1"],
  fallback_message: template,
  escalation: {
    action: "escalate",
    downgrade_to: "remind",
    days_past_due: 2,
    prior_sends: 0,
    min_prior_sends: 2,
  },
  ...over,
});

function guard(
  d: CollectionsDecision,
  opts: Partial<Parameters<typeof applyDecisionGuards>[3]> = {},
  p: AgentPolicy = policy(),
  c: SendContext = ctx(),
) {
  return applyDecisionGuards(p, c, d, guardOpts(opts));
}

describe("the escalation gate", () => {
  it("needs the days AND the reminders — neither alone is enough", () => {
    const escalate = decision({ action: "escalate", message: "Final notice for inv_1." });

    // Days met, reminders short.
    const daysOnly = guard(escalate, {
      escalation: { action: "escalate", downgrade_to: "remind", days_past_due: 200, prior_sends: 1, min_prior_sends: 2 },
    });
    expect(daysOnly.decision.action).toBe("remind");
    expect(daysOnly.overrides[0]!.detail).toContain("1 prior reminder(s), minimum 2");
    expect(daysOnly.overrides[0]!.detail).not.toContain("past due");

    // Reminders met, days short — at the shipped 60-day default.
    const remindersOnly = guard(escalate, {
      escalation: { action: "escalate", downgrade_to: "remind", days_past_due: 46, prior_sends: 3, min_prior_sends: 2 },
    });
    expect(remindersOnly.decision.action).toBe("remind");
    expect(remindersOnly.overrides[0]!.detail).toContain("46 day(s) past due, threshold 60");
    expect(remindersOnly.overrides[0]!.detail).not.toContain("prior reminder");

    // Both met: the model gets its way.
    const both = guard(escalate, {
      escalation: { action: "escalate", downgrade_to: "remind", days_past_due: 61, prior_sends: 2, min_prior_sends: 2 },
    });
    expect(both.decision.action).toBe("escalate");
    expect(both.overrides).toHaveLength(0);
  });

  it("moves with the tenant's threshold", () => {
    const escalate = decision({ action: "escalate", message: "Final notice for inv_1." });
    const rule = { action: "escalate", downgrade_to: "remind", days_past_due: 46, prior_sends: 2, min_prior_sends: 2 };

    expect(guard(escalate, { escalation: rule }, policy()).decision.action).toBe("remind");
    expect(
      guard(escalate, { escalation: rule }, policy({ escalation_threshold_days: 30 })).decision.action,
    ).toBe("escalate");
  });

  it("replaces the escalation's words, not just its label", () => {
    // A downgrade that left "legal action will follow" in place would be a
    // downgrade in the audit log only.
    const result = guard(
      decision({ action: "escalate", message: "FINAL NOTICE for inv_1. Legal action follows." }),
    );
    expect(result.decision.message).toBe(template("remind"));
    expect(result.decision.message).not.toMatch(/legal action/i);
    expect(result.overrides[0]!.detail).toContain("message replaced with the remind template");
  });

  it("leaves a non-escalating decision alone", () => {
    expect(guard(decision()).overrides).toHaveLength(0);
    expect(guard(decision({ action: "wait" })).overrides).toHaveLength(0);
  });

  it("does nothing when the caller has no escalation-shaped action", () => {
    // Agent-agnostic: an agent whose actions do not include an escalation
    // passes `escalation: null` and keeps the rest of the guard.
    const result = guard(decision({ action: "escalate", message: "inv_1" }), { escalation: null });
    expect(result.decision.action).toBe("escalate");
  });
});

describe("invoice references", () => {
  it("replaces a message citing an invoice that is not in context", () => {
    const result = guard(decision({ message: "Invoice INV-9999 is overdue. Pay today." }));
    expect(result.decision.message).toBe(template("remind"));
    expect(result.overrides[0]).toMatchObject({
      guardrail: "invoice_reference",
      outcome: "message_replaced",
    });
    expect(result.overrides[0]!.detail).toContain("INV-9999");
  });

  it("replaces a message that names no invoice at all", () => {
    // PRD-002 requires a real reference, not merely the absence of a fake one:
    // a reminder that does not say which invoice is useless to the customer.
    const result = guard(decision({ message: "Hi — a nudge about your outstanding balance." }));
    expect(result.decision.message).toBe(template("remind"));
    expect(result.overrides[0]!.detail).toContain("no invoice from the context");
  });

  it("leaves a message naming a real invoice alone", () => {
    const good = decision({ message: "About invoice inv_1, MYR 1,200.00 — could you settle it?" });
    const result = guard(good);
    expect(result.decision.message).toBe(good.message);
    expect(result.overrides).toHaveLength(0);
  });

  it("accepts a real reference alongside an invented one only if none is invented", () => {
    const result = guard(decision({ message: "Invoices inv_1 and INV-4242 are overdue." }));
    expect(result.overrides[0]!.guardrail).toBe("invoice_reference");
    expect(result.decision.message).toBe(template("remind"));
  });

  it("does not police a `wait`, which sends nothing", () => {
    const wait = decision({ action: "wait", message: "(draft) leave them be" });
    const result = guard(wait);
    expect(result.decision.message).toBe(wait.message);
    expect(result.overrides).toHaveLength(0);
  });

  it("does not police anything when the caller has no references to check", () => {
    const result = guard(decision({ message: "no invoice named here" }), { valid_refs: [] });
    expect(result.overrides).toHaveLength(0);
  });

  it("matches references case-insensitively", () => {
    const result = guard(decision({ message: "About INV_1 — please settle." }), {
      valid_refs: ["inv_1"],
    });
    expect(result.overrides).toHaveLength(0);
  });
});

describe("the character cap", () => {
  it("truncates to the tenant's cap", () => {
    const long = `Invoice inv_1. ${"Please pay. ".repeat(500)}`;
    const result = guard(decision({ message: long }), {}, policy({ max_message_chars: 500 }));
    expect(result.decision.message).toHaveLength(500);
    expect(result.overrides[0]).toMatchObject({ guardrail: "message_length", outcome: "truncated" });
    expect(result.overrides[0]!.detail).toContain("cap 500");
  });

  it("also bounds a template it just substituted", () => {
    // The cap runs last for exactly this reason.
    const result = guard(
      decision({ message: "Invoice INV-9999 is overdue." }),
      {},
      policy({ max_message_chars: 20 }),
    );
    expect(result.decision.message).toHaveLength(20);
    expect(result.overrides.map((o) => o.guardrail)).toEqual([
      "invoice_reference",
      "message_length",
    ]);
  });

  it("leaves a message inside the cap untouched", () => {
    const result = guard(decision(), {}, policy({ max_message_chars: 2000 }));
    expect(result.overrides).toHaveLength(0);
  });
});

describe("what every override record carries", () => {
  it("names the agent, the subject, the channel and the reference", () => {
    // Agent-agnostic (conflict C9): the same record shape serves a sales send.
    const result = applyDecisionGuards(
      policy(),
      ctx({ agent: "sales", subject_id: "cust_9", channel: "whatsapp", ref: "deal_7" }),
      decision({ message: "no reference here" }),
      guardOpts({ valid_refs: ["deal_7"], escalation: null }),
    );
    expect(result.overrides[0]).toMatchObject({
      agent: "sales",
      subject_type: "customer",
      subject_id: "cust_9",
      channel: "whatsapp",
      subject_ref: "deal_7",
    });
  });

  it("never mutates the decision it was given", () => {
    const original = decision({ action: "escalate", message: "Final notice INV-9999." });
    const snapshot = { ...original };
    guard(original);
    expect(original).toEqual(snapshot);
  });
});
