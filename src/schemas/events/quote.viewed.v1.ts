import { z } from "zod";

/**
 * quote.viewed.v1 — the customer opened the public quote link for the first
 * time (PRD-004 P0).
 *
 * Fires ONCE per quote, on the first view; later views only move
 * `quotes.last_viewed_at`. The "once" is enforced by a conditional UPDATE in
 * `recordQuoteView`, not by this schema.
 *
 * `ip_address` and `user_agent` are optional because the request may genuinely
 * carry neither (a client with no User-Agent, or a local request with no
 * CF-Connecting-IP). They are part of PRD-004's view record: the point of the
 * event is evidentiary — "we can show the customer opened it, from where, and
 * when" — so an events_log row is the durable copy.
 */
export const quoteViewedV1 = z.object({
  quote_id: z.string(),
  customer_id: z.string(),
  link_id: z.string(),
  viewed_at: z.string().datetime(),
  ip_address: z.string().optional(),
  user_agent: z.string().optional(),
});
export type QuoteViewedV1 = z.infer<typeof quoteViewedV1>;
