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
});
export type CollectionsDecisionV1 = z.infer<typeof collectionsDecisionV1>;
