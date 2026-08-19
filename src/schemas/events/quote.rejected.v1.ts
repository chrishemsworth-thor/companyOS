import { z } from "zod";

/**
 * quote.rejected.v1 — the quote was declined.
 *
 * S9 (PRD-004) added the decline fields, optional and additive for the same
 * reason as `quote.accepted.v1`: the operator-side reject route still exists and
 * carries none of them.
 */
export const quoteRejectedV1 = z.object({
  quote_id: z.string(),
  customer_id: z.string(),
  /** The `quote_acceptances` row recording who declined and when. */
  acceptance_id: z.string().optional(),
  signatory_name: z.string().optional(),
  signatory_email: z.string().optional(),
  /** The customer's own words. Optional — declining needs no explanation. */
  reason: z.string().optional(),
});
export type QuoteRejectedV1 = z.infer<typeof quoteRejectedV1>;
