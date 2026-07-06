import { z } from "zod";

const ticketStatus = z.enum(["open", "pending", "resolved", "closed"]);

/** ticket.status_changed.v1 — a ticket moved through the state machine. */
export const ticketStatusChangedV1 = z.object({
  ticket_id: z.string(),
  customer_id: z.string(),
  from: ticketStatus,
  to: ticketStatus,
});
export type TicketStatusChangedV1 = z.infer<typeof ticketStatusChangedV1>;
