import { z } from "zod";

/** deal.created.v1 — a new deal entered the pipeline. */
export const dealCreatedV1 = z.object({
  deal_id: z.string(),
  customer_id: z.string(),
  title: z.string(),
  value_cents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  stage_id: z.string(),
});
export type DealCreatedV1 = z.infer<typeof dealCreatedV1>;
