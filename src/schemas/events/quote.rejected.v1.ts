import { z } from "zod";

/** quote.rejected.v1 — the customer rejected the quote. */
export const quoteRejectedV1 = z.object({
  quote_id: z.string(),
  customer_id: z.string(),
});
export type QuoteRejectedV1 = z.infer<typeof quoteRejectedV1>;
