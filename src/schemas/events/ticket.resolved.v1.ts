import { z } from "zod";

/** ticket.resolved.v1 — a ticket reached resolved (companion to status_changed). */
export const ticketResolvedV1 = z.object({
  ticket_id: z.string(),
  customer_id: z.string(),
  resolved_at: z.string().datetime(),
});
export type TicketResolvedV1 = z.infer<typeof ticketResolvedV1>;
