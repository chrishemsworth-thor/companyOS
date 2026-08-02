import { z } from "zod";

/**
 * collections.decision.v1 — full audit record of every CollectionsAgent
 * decision (LLM or fallback), landed in events_log by the consumer so
 * agent behavior is inspectable after the fact.
 */
export const collectionsDecisionV1 = z.object({
  customer_id: z.string(),
  risk_score: z.number().int().min(0).max(100),
  action: z.enum(["remind", "escalate", "wait"]),
  channel: z.enum(["email", "whatsapp"]),
  message: z.string(),
  source: z.enum(["llm", "fallback"]),
  trigger: z.enum(["event", "alarm"]),
  /**
   * PRD-003 (S8): who the decision targeted and how the resolution chain got
   * there — `role` for a real billing contact, `primary`/`any` when it fell
   * back, null when the customer has no contacts at all. The PRD's second
   * contact-roles acceptance criterion requires the fallback be recorded on
   * the decision, and this is that record.
   *
   * `.optional()` rather than a v2: this schema is a non-strict z.object and
   * every field is additive, so events emitted before S8 still validate.
   * S10 carries both fields into `collections.decision.v2` alongside the
   * provider/model/token/cost fields PRD-002 adds.
   */
  contact_id: z.string().nullable().optional(),
  contact_match: z.enum(["role", "primary", "any"]).nullable().optional(),
});
export type CollectionsDecisionV1 = z.infer<typeof collectionsDecisionV1>;
