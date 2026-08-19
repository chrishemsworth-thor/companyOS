-- PRD-004 (S9) — quote branding, the public link, and click-to-sign.
--
-- Five sections, landing across the session's five phases but in one file
-- because they are one migration number:
--
--   (a) rebuild `quotes` — new lifecycle columns, and the status CHECK dropped
--   (b) `quote_links`     — the public, token-addressed view
--   (c) `quote_acceptances` + the invoice back-reference
--   (d) `quote_branding`  — uploaded logo, footer text
--   (e) the internal sign-off threshold
--
-- ============================================================================
-- (a) REBUILD `quotes`
-- ============================================================================
--
-- Two things need it. PRD-004's P1 internal sign-off introduces a new status,
-- `pending_approval`, and SQLite cannot alter a CHECK in place. And the
-- immutability requirement — "a quote cannot be edited after being sent;
-- changes require a new version" — needs version linkage columns.
--
-- The CHECK is DROPPED rather than extended, exactly as
-- 0022_roles_drop_check.sql did for `users.role` and for the same reason: the
-- rebuild is the expensive part, and paying it once to make the constraint an
-- application concern means no future status costs another one.
-- `QuoteStatus` and `QUOTE_TRANSITIONS` in src/modules/quotes/types.ts are the
-- source of truth, and every write already goes through the Zod-validated
-- service. This is a status vocabulary, not a ledger or tenant-isolation
-- guarantee — standing rule 1 is untouched.
--
-- 0022 documented the trap in detail: D1 refuses `DROP TABLE` while another
-- table's rows reference it, and every PRAGMA escape hatch (defer_foreign_keys,
-- foreign_keys=off, legacy_alter_table, writable_schema) is ignored or fails.
-- Foreign keys are checked per ROW, so the fix is for the referencing rows to
-- genuinely not exist at the moment of the DROP.
--
-- `quotes` is referenced from exactly ONE place — `quote_lines`, whose
-- (tenant_id, quote_id) FK is NOT NULL and therefore cannot be nulled. That is
-- 0022's "group 3": copy the rows out, empty the table, rebuild the parent,
-- copy them back. Nothing references `quote_lines` itself, so emptying it
-- briefly disturbs nothing else. Much smaller than the `users` case, which had
-- to touch seven referencing columns across three groups.
--
-- Everything runs inside the single transaction wrangler wraps each migration
-- file in, so a failure anywhere rolls back rather than leaving rows parked in
-- `_mig28_quote_lines`.

CREATE TABLE _mig28_quote_lines AS SELECT * FROM quote_lines;
DELETE FROM quote_lines;

CREATE TABLE quotes_new (
  quote_id       TEXT NOT NULL,               -- quote_01J...
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  quote_number   TEXT NOT NULL,               -- e.g. "Q2026-0001"
  customer_id    TEXT NOT NULL,               -- buyer organization
  contact_id     TEXT,                        -- buyer person (nullable)
  deal_id        TEXT,                        -- optional CRM linkage
  -- No CHECK: validated by `quoteStatusSchema` in src/modules/quotes/types.ts.
  -- The vocabulary is draft | pending_approval | sent | accepted | rejected |
  -- expired | converted.
  status         TEXT NOT NULL DEFAULT 'draft',
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

  -- ---- new in 0028 -------------------------------------------------------
  -- Versioning. PRD-004: "A quote cannot be edited after being sent. Changes
  -- require a new version." The new version is a whole new quote row with its
  -- own number and its own audit trail; these two columns are the only link
  -- between them, deliberately, so nothing about the superseded quote changes
  -- except the back-pointer.
  version                INTEGER NOT NULL DEFAULT 1,
  supersedes_quote_id    TEXT,
  superseded_by_quote_id TEXT,

  -- View tracking for the public link. These live on the QUOTE, not on
  -- `quote_links`, which is what makes "quote.viewed.v1 fires once" survive a
  -- link being revoked and re-issued: the first view is a fact about the quote.
  first_viewed_at TEXT,
  last_viewed_at  TEXT,
  view_count      INTEGER NOT NULL DEFAULT 0,

  -- The acceptance record that carried this quote to `accepted`. Denormalized
  -- from `quote_acceptances` so conversion can stamp it onto the invoice
  -- without a join, and so "which signature is the operative one" has exactly
  -- one answer even when P2 multi-party signing adds more rows.
  accepted_acceptance_id TEXT,

  -- Internal sign-off (PRD-004 P1) via the PRD-000b approvals primitive.
  -- `sign_off_comment` is the rejecting approver's words, carried back to the
  -- draft — the same shape PRD-006 uses for a rejected claim.
  sign_off_approval_id TEXT,
  sign_off_comment     TEXT,

  PRIMARY KEY (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, customer_id),
  UNIQUE (tenant_id, quote_number)
);

INSERT INTO quotes_new
  (quote_id, tenant_id, quote_number, customer_id, contact_id, deal_id, status, currency,
   issue_date, expiry_date, subtotal_cents, discount_total_cents, tax_rate_bps, tax_cents,
   grand_total_cents, prepared_by, approved_by, notes, converted_invoice_id,
   created_at, updated_at, sent_at, accepted_at)
SELECT
   quote_id, tenant_id, quote_number, customer_id, contact_id, deal_id, status, currency,
   issue_date, expiry_date, subtotal_cents, discount_total_cents, tax_rate_bps, tax_cents,
   grand_total_cents, prepared_by, approved_by, notes, converted_invoice_id,
   created_at, updated_at, sent_at, accepted_at
FROM quotes;

DROP TABLE quotes;
ALTER TABLE quotes_new RENAME TO quotes;

-- Recreate what 0013 created (DROP TABLE took the indexes with it), plus one
-- for walking a version chain.
CREATE INDEX idx_quotes_customer   ON quotes (tenant_id, customer_id);
CREATE INDEX idx_quotes_status     ON quotes (tenant_id, status);
CREATE INDEX idx_quotes_supersedes ON quotes (tenant_id, supersedes_quote_id);

-- Put the lines back. Every quote_id restored here came out of `quotes` above,
-- so each one resolves against the new table.
INSERT INTO quote_lines
  (quote_id, tenant_id, line_no, item_name, description, note, quantity, unit,
   unit_cents, discount_cents, line_total_cents)
SELECT
   quote_id, tenant_id, line_no, item_name, description, note, quantity, unit,
   unit_cents, discount_cents, line_total_cents
FROM _mig28_quote_lines;

DROP TABLE _mig28_quote_lines;

-- ============================================================================
-- (b) `quote_links` — the public, token-addressed view
-- ============================================================================
--
-- PRD-004 P0: `GET /q/:token`, unauthenticated. The token is a high-entropy
-- random value, NOT the quote id, and only its SHA-256 is stored — the same
-- discipline `user_tokens` (invites, password resets) and `sessions` already
-- use. A database leak therefore hands over no live links.
--
-- The unique index on `token_hash` is deliberately GLOBAL rather than
-- tenant-scoped: the public route has no tenant context and resolves the tenant
-- *from* the token, so the lookup must be by hash alone. A collision across
-- tenants would be a 32-byte-random-value collision, which is not a threat
-- model.
--
-- View state is NOT here — it lives on `quotes` (section (a)), so that revoking
-- a link and issuing a new one cannot re-fire `quote.viewed.v1`. The first view
-- is a fact about the quote, not about the link that carried it.

CREATE TABLE quote_links (
  link_id     TEXT NOT NULL,                 -- qlink_01J...
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  quote_id    TEXT NOT NULL,
  token_hash  TEXT NOT NULL,                 -- sha256(raw token); the raw value is never stored
  created_by  TEXT,                          -- usr_...; NULL for tenant-API-key callers
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Aligned to the quote's own expiry_date at mint time when it has one.
  -- PRD-004: an expired link renders an "expired" state, not a 404.
  expires_at  TEXT,
  revoked_at  TEXT,
  PRIMARY KEY (tenant_id, link_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, quote_id)
);

CREATE UNIQUE INDEX idx_quote_links_token ON quote_links (token_hash);
-- "the live link for this quote", which is the only lookup the console does.
CREATE INDEX idx_quote_links_quote ON quote_links (tenant_id, quote_id, created_at);
