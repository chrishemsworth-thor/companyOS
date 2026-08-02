-- PRD-003 (S8) — CRM depth: contact roles, commercial attributes.
--
-- Three sections, matching the PRD's own three P0 blocks:
--   (a) contact roles + the `is_primary` invariant
--   (b) commercial attributes on the customer, and the tenant default that
--       backs `payment_terms_days`
--   (c) an audit column on `deliveries` recording WHICH contact was addressed
--
-- Customer health (the PRD's third P0) needs no schema at all: it is derived
-- on read from invoices, tickets, activities and deals. See
-- src/modules/crm/health.ts.

-- ---------------------------------------------------------------------------
-- (a) Contact roles
-- ---------------------------------------------------------------------------
--
-- A join table rather than a CSV/JSON column on `contacts`, for two reasons:
-- resolveContact() is an indexed lookup by role, and PRD-003 requires
-- many-to-many in both directions ("a contact may hold several; a customer may
-- have several contacts per role").
--
-- `role` has NO SQL CHECK, deliberately, and for the reason 0022_approvals
-- recorded for `approvals.subject_type`: widening a CHECK in SQLite means a
-- table rebuild, and 0022's comment documents all four pragmas that make a
-- rebuild unavailable once dependent FKs and triggers exist. The vocabulary is
-- closed by `contactRoleSchema` in src/modules/crm/contact-roles.ts —
-- primary | billing | technical | signatory | other — and validated there on
-- every write.
CREATE TABLE contact_roles (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id),
  contact_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, contact_id, role),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, contact_id)
);

-- The resolveContact() lookup: "which contacts at this tenant hold this role".
-- Joined to contacts on (tenant_id, contact_id), which is contacts' own PK, so
-- the customer filter costs nothing extra.
CREATE INDEX idx_contact_roles_role ON contact_roles (tenant_id, role, contact_id);

-- Backfill. ORDER MATTERS: roles are written FIRST from the pre-existing
-- `is_primary` flags, then the flags are rewritten FROM the roles. Doing it the
-- other way round would have the first statement destroy the input the second
-- one needs.
--
-- PRD-003 says existing contacts migrate to `primary` on "the first (by
-- created_at)". The ranking below puts `is_primary DESC` ahead of created_at,
-- so a customer who ALREADY has an explicitly flagged primary keeps that one,
-- and only customers with none (or, possible today because nothing enforced
-- it, with several) fall back to earliest-by-created_at. Honouring a flag
-- somebody set on purpose is closer to the PRD's "a safe default, not a guess
-- at intent" than overwriting it. contact_id is a ULID and breaks created_at
-- ties deterministically.
INSERT INTO contact_roles (tenant_id, contact_id, role)
SELECT tenant_id, contact_id, CASE WHEN rn = 1 THEN 'primary' ELSE 'other' END
FROM (
  SELECT tenant_id,
         contact_id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, customer_id
           ORDER BY is_primary DESC, created_at, contact_id
         ) AS rn
  FROM contacts
);

-- Reconcile the flag from the roles just written. From here on the service
-- maintains the invariant `is_primary = 1` <=> the contact holds `primary`,
-- so the two representations PRD-003 asks for cannot disagree.
UPDATE contacts SET is_primary = CASE
  WHEN EXISTS (
    SELECT 1 FROM contact_roles r
     WHERE r.tenant_id  = contacts.tenant_id
       AND r.contact_id = contacts.contact_id
       AND r.role       = 'primary'
  ) THEN 1 ELSE 0 END;

-- "Exactly one contact per customer may be marked is_primary (enforced)".
-- The service does the swap inside a single db.batch() (clear, then set);
-- SQLite checks uniqueness per statement, so that sequence is legal inside one
-- transaction and this index is the backstop, not the mechanism.
CREATE UNIQUE INDEX idx_contacts_one_primary
  ON contacts (tenant_id, customer_id) WHERE is_primary = 1;

-- ---------------------------------------------------------------------------
-- (b) Commercial attributes
-- ---------------------------------------------------------------------------
--
-- NOT added, because 0013_quotes.sql already shipped them and the quote "To"
-- block renders them:
--   * PRD-003's `registration_no` (SSM)  -> existing customers.reg_no
--   * PRD-003's `tax_id` (SST)           -> existing customers.tax_no
--   * PRD-003's structured billing address -> existing address_line1..country
-- Adding PRD-003's names beside those would be two columns for one fact.
-- The shipping address is the genuinely new half.
ALTER TABLE customers ADD COLUMN industry           TEXT;
ALTER TABLE customers ADD COLUMN website            TEXT;
-- Nullable on purpose: NULL means "use the tenant default" rather than "0 days".
ALTER TABLE customers ADD COLUMN payment_terms_days INTEGER;
ALTER TABLE customers ADD COLUMN credit_limit_cents INTEGER;
ALTER TABLE customers ADD COLUMN preferred_channel  TEXT;   -- email | whatsapp
ALTER TABLE customers ADD COLUMN notes              TEXT;
ALTER TABLE customers ADD COLUMN ship_address_line1 TEXT;
ALTER TABLE customers ADD COLUMN ship_address_line2 TEXT;
ALTER TABLE customers ADD COLUMN ship_city          TEXT;
ALTER TABLE customers ADD COLUMN ship_state         TEXT;
ALTER TABLE customers ADD COLUMN ship_postcode      TEXT;
ALTER TABLE customers ADD COLUMN ship_country       TEXT;

-- The tenant-level default behind PRD-003's "(default from tenant settings)".
-- company_profile is the per-tenant settings row (it already carries
-- base_currency for exactly this kind of default). 30 days keeps every existing
-- tenant on the behaviour convertQuote already hardcoded.
ALTER TABLE company_profile ADD COLUMN default_payment_terms_days INTEGER NOT NULL DEFAULT 30;

-- ---------------------------------------------------------------------------
-- (c) Delivery audit
-- ---------------------------------------------------------------------------
--
-- Which contact a reminder actually addressed. Nullable: sends that fall back
-- to the customer-level email/phone (a customer with no contacts at all) have
-- no contact to record, and every row written before this migration has none.
ALTER TABLE deliveries ADD COLUMN contact_id TEXT;
