import { z } from "zod";

/** quote.converted.v1 — an accepted quote was converted into a finance invoice. */
export const quoteConvertedV1 = z.object({
  quote_id: z.string(),
  invoice_id: z.string(),
  customer_id: z.string(),
  grand_total_cents: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type QuoteConvertedV1 = z.infer<typeof quoteConvertedV1>;
