# Support Module

Native tickets with an explicit state machine and append-only conversation
threads. Replaces Libredesk. `source_module: support`.

**In scope:** tickets, threaded messages, priorities, a strict status state
machine.
**Out of scope (for now):** inbound email/chat channels, SLAs, assignment/
routing rules, canned responses. A future SupportAgent (Durable Object, same
pattern as CollectionsAgent) is the intended consumer of these events.

## Data model (`migrations/0004_support.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `tickets` | Case header | `ticket_id` (`tkt_`), `customer_id`, `subject`, `status` (`open\|pending\|resolved\|closed`), `priority` (`low\|normal\|high\|urgent`), `resolved_at` |
| `ticket_messages` | **Append-only** thread | `message_id` (`msg_`), `ticket_id` (FK), `author` (`customer\|agent\|system`), `body`, `created_at` |

## State machine (`src/modules/support/state-machine.ts`)

Transitions live in one explicit table; anything else is rejected with 409:

```
open     → pending | resolved
pending  → open | resolved
resolved → closed | open        (re-open when the customer replies)
closed   → (terminal)
```

Reaching `resolved` stamps `resolved_at` and emits `ticket.resolved` alongside
`ticket.status_changed`. `canTransition(from, to)` / `legalTransitions(from)`
are exported for reuse (and are exhaustively pinned by tests).

## API

Auth as everywhere. `SupportError` maps to 404 (`not_found`) and 409
(`illegal_transition` — the message lists the legal moves).

| Method & path | Body | Returns |
|---|---|---|
| `GET /v1/tickets?status=` | — | `{tickets: [...]}` |
| `POST /v1/tickets` | `{customer_id, subject, priority?, body?}` | 201 ticket (`open`; `body` becomes the opening customer message, atomically) |
| `GET /v1/tickets/:id` | — | ticket + `messages` thread in order |
| `POST /v1/tickets/:id/messages` | `{author, body}` | 201 message |
| `POST /v1/tickets/:id/status` | `{status}` | ticket; illegal transition → 409 |

## Events emitted

| Event | Version | Payload | When |
|---|---|---|---|
| `ticket.created` | v1 | `ticket_id, customer_id, subject, priority` | `createTicket` |
| `ticket.message_added` | v1 | `ticket_id, customer_id, message_id, author` | `addMessage` |
| `ticket.status_changed` | v1 | `ticket_id, customer_id, from, to` | `changeTicketStatus` |
| `ticket.resolved` | v1 | `ticket_id, customer_id, resolved_at` | transition to `resolved` |

All audit-logged only for now; a SupportAgent claims them via `AGENT_ROUTES`
in `src/queue/consumer.ts` when it lands.

## Service layer (`src/modules/support/service.ts`)

`createTicket` (header + optional opening message in one batch), `getTicket`,
`listTickets`, `addMessage`, `listMessages`, `changeTicketStatus`. Throws
`SupportError`.

## Tests

`test/support.test.ts` — ticket creation with opening message, thread ordering
across authors, 404s on unknown tickets, status filtering, `resolved_at`
stamping, and two exhaustive matrices: the transition table itself
(all 16 from→to pairs against the spec) and the same matrix over HTTP
(legal → 200, illegal → 409).
