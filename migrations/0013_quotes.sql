-- CompanyOS Phase 2 — native Quotes module + the CRM extension it needs
-- (source_module: 'sales'). A quote is the pre-sale document a rep sends before
-- an invoice exists: a seller "From" block, a buyer "To" block (a contact
-- person at a customer organization), priced line items with per-line discounts,
-- a single header tax (e.g. SST), and a status lifecycle that can convert into a
-- finance invoice on acceptance.
--
-- Design decisions (see docs plan): the buyer `customers` row is the
-- ORGANIZATION (extended additively here) and a new `contacts` table holds the
-- PERSON; the seller identity lives in a per-tenant `company_profile`; per-company
-- quote design lives in `quote_branding` (mirrors the delivery_config pattern —
-- no row means sensible defaults). Money is INTEGER cents, timestamps ISO TEXT,
-- every table tenant-scoped with tenant_id first in the composite PK.

-- (a) CRM extension — organization-level fields on the existing customer.
-- Additive, nullable ALTERs so every existing CRM query and the customer.created
-- event keep working untouched.
ALTER TABLE customers ADD COLUMN legal_name    TEXT;   -- registered entity name
ALTER TABLE customers ADD COLUMN reg_no        TEXT;   -- company registration no (e.g. SSM)
ALTER TABLE customers ADD COLUMN tax_no        TEXT;   -- SST/tax identifier
ALTER TABLE customers ADD COLUMN address_line1 TEXT;
ALTER TABLE customers ADD COLUMN address_line2 TEXT;
ALTER TABLE customers ADD COLUMN city          TEXT;
ALTER TABLE customers ADD COLUMN state         TEXT;
ALTER TABLE customers ADD COLUMN postcode      TEXT;
ALTER TABLE customers ADD COLUMN country       TEXT;

-- Contact persons at a customer organization. The quote "To" block names one.
CREATE TABLE contacts (
  contact_id  TEXT NOT NULL,                 -- contact_01J...
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  customer_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  title       TEXT,                          -- e.g. "Procurement Manager"
  department  TEXT,
  email       TEXT,
  phone       TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, contact_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, customer_id)
);
CREATE INDEX idx_contacts_customer ON contacts (tenant_id, customer_id);

-- (b) Seller identity — the "From" block. One row per tenant (like delivery_config).
CREATE TABLE company_profile (
  tenant_id     TEXT NOT NULL REFERENCES tenants(tenant_id),
  legal_name    TEXT NOT NULL,
  reg_no        TEXT,
  tax_no        TEXT,                         -- SST registration no
  address_line1 TEXT,
  address_line2 TEXT,
  city          TEXT,
  state         TEXT,
  postcode      TEXT,
  country       TEXT,
  phone         TEXT,
  email         TEXT,
  website       TEXT,
  default_prepared_by TEXT,                   -- default signatory name
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id)
);

-- (c) Per-company quote design. Hot brand fields as columns; the many toggles/
-- labels/formats as one Zod-validated JSON blob. No row => defaults, so the
-- document renderer never breaks.
CREATE TABLE quote_branding (
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  logo_url        TEXT,                        -- external/R2 URL (Workers has no fs)
  primary_color   TEXT NOT NULL DEFAULT '#1a1a2e',
  accent_color    TEXT NOT NULL DEFAULT '#0f3460',
  font_family     TEXT NOT NULL DEFAULT 'Helvetica, Arial, sans-serif',
  template_config TEXT NOT NULL DEFAULT '{}', -- JSON, validated by quoteTemplateConfigSchema
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id)
);

-- Per-tenant monotonic document numbering (human-friendly quote numbers,
-- distinct from the opaque quote_id). Minted in the create path; the UNIQUE
-- constraint on quotes.quote_number is the collision backstop.
CREATE TABLE document_counters (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  doc_type  TEXT NOT NULL,                    -- 'quote'
  next_seq  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, doc_type)
);

-- (d) Quotes. Totals are denormalized onto the header and recomputed on every
-- write (like invoices.total_cents). Discount lives on the line; tax on the
-- header (a single rate applied once — one rounding point).
CREATE TABLE quotes (
  quote_id       TEXT NOT NULL,               -- quote_01J...
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  quote_number   TEXT NOT NULL,               -- e.g. "Q2026-0001"
  customer_id    TEXT NOT NULL,               -- buyer organization
  contact_id     TEXT,                        -- buyer person (nullable)
  deal_id        TEXT,                        -- optional CRM linkage
  status         TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','accepted','rejected','expired','converted')),
  currency       TEXT NOT NULL CHECK (length(currency) = 3),
  issue_date     TEXT NOT NULL,               -- ISO date
  expiry_date    TEXT,                        -- ISO date
  subtotal_cents       INTEGER NOT NULL DEFAULT 0,
  discount_total_cents INTEGER NOT NULL DEFAULT 0,
  tax_rate_bps         INTEGER NOT NULL DEFAULT 0,   -- basis points, e.g. 600 = 6%
  tax_cents            INTEGER NOT NULL DEFAULT 0,
  grand_total_cents    INTEGER NOT NULL DEFAULT 0,
  prepared_by    TEXT,
  approved_by    TEXT,
  notes          TEXT,                         -- header-level note
  converted_invoice_id TEXT,                   -- set when status='converted'
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at        TEXT,
  accepted_at    TEXT,
  PRIMARY KEY (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, customer_id),
  UNIQUE (tenant_id, quote_number)
);
CREATE INDEX idx_quotes_customer ON quotes (tenant_id, customer_id);
CREATE INDEX idx_quotes_status   ON quotes (tenant_id, status);

CREATE TABLE quote_lines (
  quote_id       TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  line_no        INTEGER NOT NULL,
  item_name      TEXT NOT NULL,
  description    TEXT,
  note           TEXT,                         -- per-line note
  quantity       INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit           TEXT,                         -- "unit", "pcs", "month"
  unit_cents     INTEGER NOT NULL CHECK (unit_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  line_total_cents INTEGER NOT NULL,           -- quantity*unit_cents - discount_cents (>= 0)
  PRIMARY KEY (tenant_id, quote_id, line_no),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, quote_id)
);
