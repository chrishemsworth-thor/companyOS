import { z } from "zod";

/**
 * guardrail.override.v1 — a hard guardrail changed or blocked what an agent was
 * about to do (PRD-002 P0: "the override is logged").
 *
 * **Deliberately agent-agnostic, and deliberately the only override event.**
 * SESSION-PLAN conflict C9: a sales guardrail firing is the same concept as a
 * collections one, and a second event type would split PRD-002's override-rate
 * metric across two names and quietly halve both. S15's SalesAgent emits this
 * event, with `agent: "sales"` and a deal in `subject_ref`.
 *
 * Not every guardrail check that stops a send lands here. A disabled tenant, a
 * paused customer and the 24h cooldown are standing instructions rather than
 * the guard correcting the agent, and the overdue sweep re-checks them daily —
 * auditing those would write a row a day per paused customer and make the
 * override rate meaningless. See `src/agents/guardrails/guard.ts`.
 */
export const guardrailOverrideV1 = z.object({
  /** Which agent was overridden: "collections" today. */
  agent: z.string().min(1),
  /** What the send was aimed at. A customer today; S15 may add others. */
  subject_type: z.literal("customer"),
  subject_id: z.string(),
  channel: z.enum(["email", "whatsapp"]),
  /** Which rule fired. */
  guardrail: z.enum([
    "reminder_cap",
    "contact_window",
    "escalation_gate",
    "invoice_reference",
    "message_length",
  ]),
  /** What the guard did about it. */
  outcome: z.enum(["suppressed", "deferred", "downgraded", "message_replaced", "truncated"]),
  /** The action the agent chose, and what it became. Equal when only the
   * message changed; both null for a pre-decision suppression. */
  from_action: z.string().nullable(),
  to_action: z.string().nullable(),
  /** The thing being chased — an invoice id today. */
  subject_ref: z.string().nullable(),
  /** Human-readable reason, for the console badge's tooltip and for support. */
  detail: z.string(),
  /** Set when `outcome` is `deferred`: when the send was rescheduled to.
   * PRD-002 requires deferral, never dropping, and this is the proof. */
  defer_until: z.string().nullable(),
});
export type GuardrailOverrideV1 = z.infer<typeof guardrailOverrideV1>;
