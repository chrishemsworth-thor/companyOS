-- PRD-004 (S9) — quote branding, the public link, and click-to-sign.
--
-- Five sections, landing across the session's five phases but in one file
-- because they are one migration number:
--
--   (a) rebuild `quotes` — new lifecycle columns, and the status CHECK dropped
--   (b) `quote_links`     — the public, token-addressed view
--   (c) `quote_branding`  — uploaded logo, footer text
--   (d) `quote_acceptances` + the invoice back-reference
--   (e) the internal sign-off threshold
--
-- (c) lands before (d) even though PRD-004 lists the logo after acceptance.
-- The artifact frozen at acceptance has to inline the logo to stay renderable
-- after the tenant changes it, so the logo has to exist first — doing it the
-- other way round means writing the acceptance path twice.
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

-- ============================================================================
-- (c) `quote_branding` — the uploaded logo and the document footer
-- ============================================================================
--
-- PRD-004 P0: "Logo upload via PRD-000 file storage (purpose = quote_logo),
-- referenced from tenant branding settings" and "optional accent colour and
-- footer text (terms, bank details, registration numbers)".
--
-- The accent colour already exists (`accent_color`, from 0013) and is already
-- rendered, so only two columns are new. `logo_url` — an externally hosted
-- image — stays and keeps working; `logo_file_id` wins when both are set,
-- because a file this system owns cannot rot the way somebody else's URL can.
--
-- No FK to `files`. The files primitive soft-deletes (0021), so a hard
-- reference would either block a delete or leave a dangling one; the settings
-- write path validates the id against the caller's tenant and the `quote_logo`
-- purpose instead, which is where a wrong value can actually be explained.

ALTER TABLE quote_branding ADD COLUMN logo_file_id TEXT;
ALTER TABLE quote_branding ADD COLUMN footer_text  TEXT;

-- ============================================================================
-- (d) `quote_acceptances` — the evidentiary record, and the invoice link
-- ============================================================================
--
-- PRD-004's whole point: *"today a CompanyOS quote has no evidentiary value —
-- there is no record that the customer saw the document, when, or that they
-- agreed to its specific contents."* This table is that record.
--
-- ONE ROW PER SIGNATORY, deliberately. PRD-004 puts multi-party counter-signing
-- in P2 with the instruction to "keep the acceptance record as a row per
-- signatory so this is additive" — so a second signatory is a second row and no
-- schema change. `quotes.accepted_acceptance_id` names the operative one.
--
-- Declines live here too. A decline has the same evidentiary shape (who, when,
-- from where, against which document) and differs only in carrying no artifact;
-- a separate table would duplicate every column to express one boolean.
--
-- `agreement_text` is stored VERBATIM rather than as a pointer to the versioned
-- constant in src/modules/quotes/agreement.ts. A record of what somebody agreed
-- to that changes when the constant changes is not a record. The version is
-- stored alongside it so the two can be checked against each other.
--
-- `document_sha256` is the load-bearing column. It is the SHA-256 the files
-- primitive computed over the archived artifact — the same value, copied, never
-- recomputed — so "the stored artifact's hash equals the hash in the acceptance
-- record" is true by construction rather than by a second calculation that
-- could drift.

CREATE TABLE quote_acceptances (
  acceptance_id     TEXT NOT NULL,            -- qacc_01J...
  tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id),
  quote_id          TEXT NOT NULL,
  link_id           TEXT NOT NULL,            -- which public link carried it
  -- 'accepted' | 'declined'. No CHECK, matching this migration's other
  -- vocabulary columns: validated by Zod in the service.
  decision          TEXT NOT NULL,

  signatory_name    TEXT NOT NULL,
  signatory_email   TEXT NOT NULL,
  -- The PRD-003 contact this signatory was matched to, and which rung of
  -- resolveContact's chain answered ('role' | 'primary' | 'any'). Both NULL
  -- when the customer has no contacts at all, which is a normal outcome.
  contact_id        TEXT,
  contact_match     TEXT,

  agreement_version TEXT NOT NULL,
  agreement_text    TEXT NOT NULL,

  -- Accepted only. A decline agrees to nothing, so there is nothing to freeze.
  document_sha256   TEXT,
  artifact_file_id  TEXT,
  signature_file_id TEXT,                     -- purpose = signature, optional
  decline_reason    TEXT,

  -- PRD-004's audit record: "IP address, user agent, UTC timestamp".
  ip_address        TEXT,
  user_agent        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (tenant_id, acceptance_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, quote_id)
);

CREATE INDEX idx_quote_acceptances_quote
  ON quote_acceptances (tenant_id, quote_id, created_at);

-- PRD-004: "Conversion to invoice carries a reference to the acceptance
-- record." Nullable ALTERs — `invoices` has no CHECK to fight and every
-- existing invoice predates quotes-with-signatures, so both stay NULL there.
ALTER TABLE invoices ADD COLUMN quote_id            TEXT;
ALTER TABLE invoices ADD COLUMN quote_acceptance_id TEXT;

-- ============================================================================
-- (e) Internal sign-off threshold
-- ============================================================================
--
-- PRD-004 P1: "Tenant setting: quotes above a value threshold require internal
-- approval before send." NULL means no threshold and no sign-off, which is the
-- behaviour every existing tenant already has — so this column changes nothing
-- until somebody sets it.
--
-- It lives on `quote_branding` despite the table's name because that table is
-- already the per-tenant quote CONFIGURATION surface, not just its design: it
-- carries the tax rate, the document currency and the terms text today. A
-- separate one-row-per-tenant `quote_settings` table would be a second thing to
-- join for one integer.

ALTER TABLE quote_branding ADD COLUMN sign_off_threshold_cents INTEGER;
