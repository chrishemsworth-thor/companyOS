import { z } from "zod";

/** ticket.message_added.v1 — a message was appended to a ticket thread. */
export const ticketMessageAddedV1 = z.object({
  ticket_id: z.string(),
  customer_id: z.string(),
  message_id: z.string(),
  author: z.enum(["customer", "agent", "system"]),
});
export type TicketMessageAddedV1 = z.infer<typeof ticketMessageAddedV1>;
