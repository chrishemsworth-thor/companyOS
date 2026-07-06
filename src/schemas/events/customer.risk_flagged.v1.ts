import { z } from "zod";

/**
 * customer.risk_flagged.v1 — the CollectionsAgent escalated a customer.
 * Named in the phase-0 design; emitted since Phase 2 when the escalation
 * ladder reaches `escalated`. Audit-logged only for now (no agent route);
 * a future notification consumer can claim it.
 */
export const customerRiskFlaggedV1 = z.object({
  customer_id: z.string(),
  risk_score: z.number().int().min(0).max(100),
  open_invoices: z.array(z.string()),
  total_due_cents: z.number().int().nonnegative(),
});
export type CustomerRiskFlaggedV1 = z.infer<typeof customerRiskFlaggedV1>;
