import { z } from "zod";

/** quote.expired.v1 — a sent quote passed its expiry date (daily sweep). */
export const quoteExpiredV1 = z.object({
  quote_id: z.string(),
  customer_id: z.string(),
});
export type QuoteExpiredV1 = z.infer<typeof quoteExpiredV1>;
