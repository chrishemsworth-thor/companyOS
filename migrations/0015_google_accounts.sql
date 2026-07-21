-- Google (Gmail/Workspace) email connectivity — connected-account storage.
--
-- One row per connected Google mailbox. Two kinds:
--   'shared' — a tenant-owned mailbox (e.g. support@company.com). user_id NULL.
--              An admin runs the OAuth flow once; the whole tenant sends as it.
--   'user'   — a personal mailbox owned by exactly one operator, who connected
--              it so CompanyOS can send as them. Private within the tenant.
--
-- Unlike webhook_sources (whose per-source secret is DERIVED from a master key,
-- so nothing sensitive is stored), Google issues an opaque refresh token that
-- must be recovered byte-for-byte to mint access tokens. It is therefore stored
-- ENCRYPTED at rest (AES-256-GCM, key = GOOGLE_TOKEN_ENCRYPTION_KEY) — see
-- src/integrations/google/crypto.ts. Short-lived access tokens are never stored
-- here; they are cached in CONFIG_CACHE KV keyed by account_id.
CREATE TABLE google_accounts (
  account_id       TEXT PRIMARY KEY,             -- gac_<ulid>
  tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
  kind             TEXT NOT NULL CHECK (kind IN ('shared','user')),
  -- Owner for kind='user' (NULL for 'shared'). A personal connection is usable
  -- only by this user; a shared connection is usable by the whole tenant.
  user_id          TEXT REFERENCES users(user_id),
  label            TEXT,                          -- operator-facing name, e.g. "Support inbox"
  google_email     TEXT NOT NULL,                 -- the connected mailbox address
  google_sub       TEXT,                          -- Google's stable subject id (identity binding)
  scopes           TEXT NOT NULL,                 -- space-separated, as actually granted by Google
  refresh_token_ciphertext TEXT NOT NULL,          -- AES-256-GCM ciphertext, base64
  refresh_token_iv         TEXT NOT NULL,          -- base64 96-bit nonce
  enc_key_version  INTEGER NOT NULL DEFAULT 1,     -- supports future key rotation
  history_id       TEXT,                           -- Gmail inbound sync checkpoint (Phase 2; NULL until enabled)
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','error')),
  last_error       TEXT,
  connected_by_user_id TEXT REFERENCES users(user_id),  -- who ran the OAuth flow (audit trail)
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_google_accounts_tenant ON google_accounts (tenant_id);

-- One personal connection per user per tenant, and one shared connection per
-- mailbox address per tenant. Partial indexes so the two kinds don't collide.
CREATE UNIQUE INDEX idx_google_accounts_user
  ON google_accounts (tenant_id, user_id) WHERE kind = 'user';
CREATE UNIQUE INDEX idx_google_accounts_shared_email
  ON google_accounts (tenant_id, google_email) WHERE kind = 'shared';
