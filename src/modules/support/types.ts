import type { TicketStatus } from "./state-machine";

/** Support module domain types. */

export type TicketPriority = "low" | "normal" | "high" | "urgent";

export interface Ticket {
  ticket_id: string;
  customer_id: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export type MessageAuthor = "customer" | "agent" | "system";

export interface TicketMessage {
  message_id: string;
  ticket_id: string;
  author: MessageAuthor;
  body: string;
  created_at: string;
}
