import { z } from "zod";

/** deal.lost.v1 — a deal reached a losing stage. */
export const dealLostV1 = z.object({
  deal_id: z.string(),
  customer_id: z.string(),
  value_cents: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type DealLostV1 = z.infer<typeof dealLostV1>;
