import { z } from "zod";

/** quote.created.v1 — a new quote was drafted. */
export const quoteCreatedV1 = z.object({
  quote_id: z.string(),
  quote_number: z.string(),
  customer_id: z.string(),
  contact_id: z.string().optional(),
  currency: z.string().length(3),
  grand_total_cents: z.number().int().nonnegative(),
});
export type QuoteCreatedV1 = z.infer<typeof quoteCreatedV1>;
