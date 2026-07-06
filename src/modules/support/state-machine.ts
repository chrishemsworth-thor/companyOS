/**
 * Ticket state machine. Transitions live in one explicit table so the legal
 * moves are auditable at a glance; the service layer rejects anything else
 * with 409.
 *
 *   open     → pending | resolved
 *   pending  → open | resolved
 *   resolved → closed | open      (re-open when the customer replies)
 *   closed   → (terminal)
 */

export type TicketStatus = "open" | "pending" | "resolved" | "closed";

const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["pending", "resolved"],
  pending: ["open", "resolved"],
  resolved: ["closed", "open"],
  closed: [],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function legalTransitions(from: TicketStatus): readonly TicketStatus[] {
  return TRANSITIONS[from];
}
