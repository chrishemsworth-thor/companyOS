-- Migration 0010: human identity & sessions.
--
-- Turns the single-trusted-operator model (one pasted tenant API key) into
-- real per-tenant human users with server-side sessions. The tenant API key
-- stays the credential for programmatic/agent callers; humans authenticate
-- with email + password and ride a session cookie the browser never trades
-- for the raw tenant key.

-- Per-tenant human users. Credential columns are nullable and discriminated by
-- cred_type so passkey/SSO credentials can be added later without a rewrite.
CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,              -- usr_<ulid>
  tenant_id     TEXT NOT NULL REFERENCES tenants(tenant_id),
  email         TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'operator'
                  CHECK (role IN ('admin', 'operator', 'finance', 'support', 'readonly')),
  cred_type     TEXT NOT NULL DEFAULT 'password' CHECK (cred_type IN ('password')),
  pwd_hash      TEXT,                           -- PBKDF2-HMAC-SHA256 derived key (hex)
  pwd_salt      TEXT,                           -- per-user random salt (hex)
  pwd_iter      INTEGER,                        -- iteration count, stored so it can be raised later
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
);
-- Global-unique email (phase-2 simplification: one user = one tenant, so
-- login by email alone is unambiguous). If a person must span tenants later,
-- switch to UNIQUE (tenant_id, email) + a workspace selector at login.
CREATE UNIQUE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_tenant ON users (tenant_id);

-- Durable session record. KV holds the hot lookup copy (see src/auth/session.ts);
-- this table is the revocable, listable source of truth and feeds a future
-- "active sessions" admin view + hard revocation.
CREATE TABLE sessions (
  session_hash  TEXT PRIMARY KEY,               -- sha256(raw token); the raw token is never stored
  tenant_id     TEXT NOT NULL REFERENCES tenants(tenant_id),
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  csrf_token    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id, expires_at);
