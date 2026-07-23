-- Migration 0019: transactional email foundation + user lifecycle tokens.
--
-- 1) Generalize the deliveries audit log beyond invoice reminders: every
--    outbound email now records a `purpose` (user invites, password resets,
--    and future invoice/receipt/quote mail share the same audit trail), an
--    optional recipient `user_id` for staff-facing mail, and the `subject`.
--    invoice_id/customer_id become nullable — non-invoice mail has neither.
--    SQLite can't relax NOT NULL in place, so rebuild the (append-only)
--    table exactly as migration 0016 did. Nothing references deliveries by
--    foreign key, so the drop/rename is safe.
CREATE TABLE deliveries_new (
  delivery_id  TEXT NOT NULL,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  purpose      TEXT NOT NULL DEFAULT 'reminder'
                 CHECK (purpose IN ('reminder', 'user_invite', 'password_reset',
                                    'invoice', 'receipt', 'quote', 'internal_alert')),
  invoice_id   TEXT,
  customer_id  TEXT,
  user_id      TEXT,
  subject      TEXT,
  channel      TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  provider     TEXT NOT NULL CHECK (provider IN ('console', 'resend', 'twilio', 'google')),
  to_address   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  delivery_ref TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, delivery_id)
);

INSERT INTO deliveries_new
  (delivery_id, tenant_id, invoice_id, customer_id, channel, provider, to_address, status, delivery_ref, created_at)
  SELECT delivery_id, tenant_id, invoice_id, customer_id, channel, provider, to_address, status, delivery_ref, created_at
  FROM deliveries;

DROP TABLE deliveries;
ALTER TABLE deliveries_new RENAME TO deliveries;

CREATE INDEX idx_deliveries_customer ON deliveries (tenant_id, customer_id, created_at);
CREATE INDEX idx_deliveries_invoice ON deliveries (tenant_id, invoice_id);
CREATE INDEX idx_deliveries_purpose ON deliveries (tenant_id, purpose, created_at);

-- 2) Single-use user lifecycle tokens (invites + password resets). Same
--    hashed-at-rest discipline as sessions: only sha256(raw) is stored, the
--    raw token exists once — inside the emailed link. A user with
--    pwd_hash IS NULL is an invited/pending account (authenticateUser already
--    rejects null-hash users), so no users-table change is needed.
CREATE TABLE user_tokens (
  token_hash  TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  purpose     TEXT NOT NULL CHECK (purpose IN ('invite', 'password_reset')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_by  TEXT
);
CREATE INDEX idx_user_tokens_user ON user_tokens (user_id, purpose, expires_at);
