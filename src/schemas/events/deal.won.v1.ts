import { z } from "zod";

/** deal.won.v1 — a deal reached a winning stage. */
export const dealWonV1 = z.object({
  deal_id: z.string(),
  customer_id: z.string(),
  value_cents: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type DealWonV1 = z.infer<typeof dealWonV1>;
