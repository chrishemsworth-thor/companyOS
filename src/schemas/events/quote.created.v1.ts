import { z } from "zod";

/** quote.created.v1 — a new quote was drafted. */
export const quoteCreatedV1 = z.object({
  quote_id: z.string(),
  quote_number: z.string(),
  customer_id: z.string(),
  contact_id: z.string().optional(),
  currency: z.string().length(3),
  grand_total_cents: z.number().int().nonnegative(),
  /**
   * Set when this quote was created as the next version of a locked one
   * (PRD-004 immutability, S9). Optional and additive to a non-strict schema,
   * so no v2 — the same treatment S8 gave `collections.decision.v1`.
   */
  supersedes_quote_id: z.string().optional(),
});
export type QuoteCreatedV1 = z.infer<typeof quoteCreatedV1>;
