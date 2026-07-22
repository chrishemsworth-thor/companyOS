-- CompanyOS Sales Phase A — leads (pre-customer prospects; see
-- docs/architecture/sales-module-design.md). A lead is a PERSON we are
-- pursuing, optionally at a company; converting it creates a customer
-- (+ contact + optional deal) and freezes the lead with lineage ids.
-- source_module: 'sales'.

CREATE TABLE leads (
  lead_id     TEXT NOT NULL,                 -- lead_01J...
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  name        TEXT NOT NULL,                 -- the person
  company     TEXT,                          -- their organization (customer name on convert)
  email       TEXT,
  phone       TEXT,
  title       TEXT,                          -- e.g. "Head of Procurement"
  source      TEXT NOT NULL DEFAULT 'manual',-- free text: 'manual' | 'import' | 'webform' | ...
  status      TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'qualified', 'converted', 'lost')),
  notes       TEXT,
  enriched_at TEXT,                          -- last enrichment that filled a field (ISO)
  converted_customer_id TEXT,                -- set when status='converted'
  converted_deal_id     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, lead_id)
);
CREATE INDEX idx_leads_status ON leads (tenant_id, status);
