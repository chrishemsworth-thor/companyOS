import { z } from "zod";

/** ticket.created.v1 — a new support ticket was opened. */
export const ticketCreatedV1 = z.object({
  ticket_id: z.string(),
  customer_id: z.string(),
  subject: z.string(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
});
export type TicketCreatedV1 = z.infer<typeof ticketCreatedV1>;
