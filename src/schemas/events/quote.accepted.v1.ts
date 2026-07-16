import { z } from "zod";

/** quote.accepted.v1 — the customer accepted the quote. */
export const quoteAcceptedV1 = z.object({
  quote_id: z.string(),
  customer_id: z.string(),
  accepted_at: z.string().datetime(),
});
export type QuoteAcceptedV1 = z.infer<typeof quoteAcceptedV1>;
