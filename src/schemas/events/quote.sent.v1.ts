import { z } from "zod";

/** quote.sent.v1 — a quote was issued to the customer. */
export const quoteSentV1 = z.object({
  quote_id: z.string(),
  customer_id: z.string(),
  sent_at: z.string().datetime(),
});
export type QuoteSentV1 = z.infer<typeof quoteSentV1>;
