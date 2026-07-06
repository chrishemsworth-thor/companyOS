-- CompanyOS Phase 1 — native CRM module (source_module: 'sales').
-- customers becomes a native root entity; deals move through per-tenant
-- pipeline stages; activities is an append-only touch log shared with agents
-- (the CollectionsAgent records reminder_sent rows here).

ALTER TABLE customers ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

-- Pipeline stages. Defaults are seeded per tenant on first use.
CREATE TABLE pipeline_stages (
  stage_id   TEXT NOT NULL,                  -- stg_01J...
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_won     INTEGER NOT NULL DEFAULT 0,
  is_lost    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, stage_id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE deals (
  deal_id     TEXT NOT NULL,                 -- deal_01J...
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  customer_id TEXT NOT NULL,
  title       TEXT NOT NULL,
  value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
  currency    TEXT NOT NULL CHECK (length(currency) = 3),
  stage_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, deal_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, customer_id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES pipeline_stages(tenant_id, stage_id)
);
CREATE INDEX idx_deals_stage ON deals (tenant_id, stage_id, status);

-- Append-only touch log: notes, calls, emails, agent-sent reminders.
CREATE TABLE activities (
  activity_id TEXT NOT NULL,                 -- act_01J...
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  customer_id TEXT NOT NULL,
  deal_id     TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('note', 'call', 'email', 'meeting', 'reminder_sent')),
  body        TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, activity_id)
);
CREATE INDEX idx_activities_customer ON activities (tenant_id, customer_id, occurred_at);
