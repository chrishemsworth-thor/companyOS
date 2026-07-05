-- CompanyOS Phase 0 — gateway-normalized data spine.
-- D1 is SQLite: TEXT primary keys (ULIDs / prefixed ids), ISO-8601 timestamps as TEXT,
-- money as INTEGER cents to avoid float drift.

-- SME accounts. One row per business running on CompanyOS.
CREATE TABLE tenants (
  tenant_id   TEXT PRIMARY KEY,              -- e.g. biz_abc123
  name        TEXT NOT NULL,
  -- API key the tenant's clients present to the gateway (hashed, never plaintext).
  api_key_hash TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Per-tenant credentials for each OSS module instance (ERPNext, Twenty, ...).
-- Source of truth lives here (strongly consistent); KV only caches resolved rows.
CREATE TABLE tenant_credentials (
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  module      TEXT NOT NULL CHECK (module IN ('finance', 'people', 'sales', 'support', 'build')),
  base_url    TEXT NOT NULL,                 -- e.g. https://erp.tenant.example.com
  api_key     TEXT NOT NULL,
  api_secret  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, module)
);

-- Normalized customer records (projection of module-native data).
CREATE TABLE customers (
  customer_id TEXT NOT NULL,                 -- e.g. cust_456
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  source_ref  TEXT,                          -- module-native id (e.g. ERPNext Customer name)
  PRIMARY KEY (tenant_id, customer_id)
);

-- Normalized invoice records.
CREATE TABLE invoices (
  invoice_id   TEXT NOT NULL,                -- e.g. inv_789
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  customer_id  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'overdue', 'partially_paid', 'paid', 'cancelled')),
  amount_due_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL,                -- ISO 4217, e.g. MYR
  due_date     TEXT NOT NULL,                -- ISO date
  source_ref   TEXT,                         -- module-native id (e.g. ERPNext Sales Invoice name)
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, invoice_id)
);
CREATE INDEX idx_invoices_status ON invoices (tenant_id, status);

-- Append-only log of every event that flowed through the bus.
-- The observable record for the vertical-slice round trip, and later, agent audit.
CREATE TABLE events_log (
  event_id    TEXT PRIMARY KEY,              -- ULID, time-sortable
  event_type  TEXT NOT NULL,                 -- e.g. invoice.overdue
  source_module TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  trace_id    TEXT NOT NULL,
  payload     TEXT NOT NULL,                 -- JSON
  logged_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_events_log_tenant ON events_log (tenant_id, occurred_at);
