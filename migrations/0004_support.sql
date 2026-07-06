-- CompanyOS Phase 1 — native support module.
-- Tickets move through an explicit state machine enforced in the service
-- layer (src/modules/support/state-machine.ts); messages are an append-only
-- conversation thread.

CREATE TABLE tickets (
  ticket_id   TEXT NOT NULL,                 -- tkt_01J...
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  customer_id TEXT NOT NULL,
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT,
  PRIMARY KEY (tenant_id, ticket_id)
);
CREATE INDEX idx_tickets_status ON tickets (tenant_id, status, priority);

CREATE TABLE ticket_messages (
  message_id  TEXT NOT NULL,                 -- msg_01J...
  tenant_id   TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  author      TEXT NOT NULL CHECK (author IN ('customer', 'agent', 'system')),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, message_id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets(tenant_id, ticket_id)
);
CREATE INDEX idx_ticket_messages_ticket ON ticket_messages (tenant_id, ticket_id, created_at);
