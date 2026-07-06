-- CompanyOS Phase 2 — real delivery providers (Workstream 1).
-- delivery_config: per-tenant sender identity and opt-in. A real provider
-- (Resend/Twilio) is only used when the worker secret is configured AND the
-- tenant has an enabled row for the channel — accidental live sends are
-- impossible until both exist.
CREATE TABLE delivery_config (
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  channel      TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  from_address TEXT NOT NULL,                 -- email address or E.164 phone number
  enabled      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, channel)
);

-- Append-only log of every send attempt through the DeliveryProvider port.
-- Collections needs to know what was actually sent; Phase 3 insights joins on it.
CREATE TABLE deliveries (
  delivery_id  TEXT NOT NULL,                 -- dlv_01J...
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  invoice_id   TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  provider     TEXT NOT NULL CHECK (provider IN ('console', 'resend', 'twilio')),
  to_address   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  delivery_ref TEXT,                          -- provider message id; NULL on failure
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, delivery_id)
);
CREATE INDEX idx_deliveries_customer ON deliveries (tenant_id, customer_id, created_at);
CREATE INDEX idx_deliveries_invoice ON deliveries (tenant_id, invoice_id);
