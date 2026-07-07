import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { paginate } from "../../gateway/pagination";
import { canTransition, legalTransitions, type TicketStatus } from "./state-machine";
import type { MessageAuthor, Ticket, TicketMessage, TicketPriority } from "./types";

/** Native support service. Same write-then-emit pattern as finance/CRM. */

export class SupportError extends Error {
  constructor(
    readonly code: "not_found" | "illegal_transition",
    message: string,
    readonly httpStatus: 404 | 409 = 409,
  ) {
    super(message);
    this.name = "SupportError";
  }
}

const TICKET_COLUMNS =
  "ticket_id, customer_id, subject, status, priority, created_at, updated_at, resolved_at";

export async function getTicket(
  db: D1Database,
  tenantId: string,
  ticketId: string,
): Promise<Ticket | null> {
  return db
    .prepare(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE tenant_id = ? AND ticket_id = ?`)
    .bind(tenantId, ticketId)
    .first<Ticket>();
}

export async function listTickets(
  db: D1Database,
  tenantId: string,
  filter: { status?: TicketStatus; cursor?: string; limit: number },
): Promise<{ tickets: Ticket[]; next_cursor: string | null }> {
  const clauses = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (filter.status) {
    clauses.push("status = ?");
    binds.push(filter.status);
  }
  if (filter.cursor) {
    clauses.push("ticket_id > ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT ${TICKET_COLUMNS} FROM tickets WHERE ${clauses.join(" AND ")}
       ORDER BY ticket_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<Ticket>();
  const { items, next_cursor } = paginate(results, filter.limit, "ticket_id");
  return { tickets: items, next_cursor };
}

export async function createTicket(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: { customer_id: string; subject: string; priority?: TicketPriority; body?: string },
): Promise<Ticket> {
  const ticketId = `tkt_${ulid()}`;
  const priority = input.priority ?? "normal";

  const statements = [
    env.DB.prepare(
      `INSERT INTO tickets (ticket_id, tenant_id, customer_id, subject, priority)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(ticketId, tenantId, input.customer_id, input.subject, priority),
  ];
  if (input.body) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO ticket_messages (message_id, tenant_id, ticket_id, author, body)
         VALUES (?, ?, ?, 'customer', ?)`,
      ).bind(`msg_${ulid()}`, tenantId, ticketId, input.body),
    );
  }
  await env.DB.batch(statements);

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "ticket.created",
      source_module: "support",
      tenant_id: tenantId,
      payload: {
        ticket_id: ticketId,
        customer_id: input.customer_id,
        subject: input.subject,
        priority,
      },
    }),
  );

  return (await getTicket(env.DB, tenantId, ticketId))!;
}

export async function listMessages(
  db: D1Database,
  tenantId: string,
  ticketId: string,
): Promise<TicketMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT message_id, ticket_id, author, body, created_at FROM ticket_messages
       WHERE tenant_id = ? AND ticket_id = ? ORDER BY created_at`,
    )
    .bind(tenantId, ticketId)
    .all<TicketMessage>();
  return results;
}

export async function addMessage(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  ticketId: string,
  input: { author: MessageAuthor; body: string },
): Promise<TicketMessage> {
  const ticket = await getTicket(env.DB, tenantId, ticketId);
  if (!ticket) throw new SupportError("not_found", "ticket not found", 404);

  const messageId = `msg_${ulid()}`;
  await env.DB.prepare(
    `INSERT INTO ticket_messages (message_id, tenant_id, ticket_id, author, body)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(messageId, tenantId, ticketId, input.author, input.body)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "ticket.message_added",
      source_module: "support",
      tenant_id: tenantId,
      payload: {
        ticket_id: ticketId,
        customer_id: ticket.customer_id,
        message_id: messageId,
        author: input.author,
      },
    }),
  );

  return (await env.DB.prepare(
    "SELECT message_id, ticket_id, author, body, created_at FROM ticket_messages WHERE tenant_id = ? AND message_id = ?",
  )
    .bind(tenantId, messageId)
    .first<TicketMessage>())!;
}

export async function changeTicketStatus(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  ticketId: string,
  to: TicketStatus,
): Promise<Ticket> {
  const ticket = await getTicket(env.DB, tenantId, ticketId);
  if (!ticket) throw new SupportError("not_found", "ticket not found", 404);
  if (!canTransition(ticket.status, to)) {
    throw new SupportError(
      "illegal_transition",
      `cannot move ${ticket.status} → ${to}; legal: ${legalTransitions(ticket.status).join(", ") || "(none)"}`,
    );
  }

  const now = new Date().toISOString();
  const resolvedAt = to === "resolved" ? now : ticket.resolved_at;
  await env.DB.prepare(
    "UPDATE tickets SET status = ?, resolved_at = ?, updated_at = ? WHERE tenant_id = ? AND ticket_id = ?",
  )
    .bind(to, resolvedAt, now, tenantId, ticketId)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "ticket.status_changed",
      source_module: "support",
      tenant_id: tenantId,
      payload: { ticket_id: ticketId, customer_id: ticket.customer_id, from: ticket.status, to },
    }),
  );
  if (to === "resolved") {
    await env.EVENTS.send(
      makeEnvelope({
        event_type: "ticket.resolved",
        source_module: "support",
        tenant_id: tenantId,
        payload: { ticket_id: ticketId, customer_id: ticket.customer_id, resolved_at: now },
      }),
    );
  }

  return (await getTicket(env.DB, tenantId, ticketId))!;
}
