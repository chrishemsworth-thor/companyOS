-- Migration 0022: make the role vocabulary an application concern.
--
-- `users.role` carried `CHECK (role IN ('admin','operator','finance','support',
-- 'readonly'))`. SQLite cannot alter a CHECK in place, so every future role
-- would have cost a full table rebuild. PRD-008 spends that rebuild once, here,
-- to drop the constraint entirely: `src/auth/roles.ts` becomes the single source
-- of truth (it already is for the app — Zod validates writes with
-- `z.enum(ROLES)`), and adding a role never touches D1 again.
--
-- `users(user_id)` is FK-referenced from five places — `sessions`,
-- `google_accounts` (`user_id` *and* `connected_by_user_id`), `employees` and
-- `user_tokens` — so dropping the old table mid-transaction would trip foreign
-- key enforcement while the children still point at it. `PRAGMA
-- defer_foreign_keys` moves that check to commit time, by which point the new
-- table has taken the old one's name and every reference resolves again.
--
-- No row changes: the five existing roles keep their exact values, so no user
-- gains or loses access from this migration. What changes their effective
-- access is the capability matrix (`src/auth/capabilities.ts`) now being
-- enforced on every route — documented in docs/prd/PRD-008.
PRAGMA defer_foreign_keys = on;

CREATE TABLE users_new (
  user_id       TEXT PRIMARY KEY,              -- usr_<ulid>
  tenant_id     TEXT NOT NULL REFERENCES tenants(tenant_id),
  email         TEXT NOT NULL,
  display_name  TEXT,
  -- No CHECK: validated by `ROLES` in src/auth/roles.ts. Defaults to the
  -- least-privilege self-service tier so a row written without an explicit
  -- role can never be a business-capable account.
  role          TEXT NOT NULL DEFAULT 'employee',
  cred_type     TEXT NOT NULL DEFAULT 'password' CHECK (cred_type IN ('password')),
  pwd_hash      TEXT,                           -- PBKDF2-HMAC-SHA256 derived key (hex)
  pwd_salt      TEXT,                           -- per-user random salt (hex)
  pwd_iter      INTEGER,                        -- iteration count, stored so it can be raised later
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
);

INSERT INTO users_new
  (user_id, tenant_id, email, display_name, role, cred_type, pwd_hash, pwd_salt,
   pwd_iter, status, created_at, updated_at, last_login_at)
SELECT
   user_id, tenant_id, email, display_name, role, cred_type, pwd_hash, pwd_salt,
   pwd_iter, status, created_at, updated_at, last_login_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Recreate the indexes the old table carried (DROP TABLE took them with it).
-- Names must match what exists today: migration 0012 replaced 0010's globally
-- unique `idx_users_email` with the tenant-scoped `idx_users_email_tenant`,
-- which is why login resolves a workspace first.
CREATE UNIQUE INDEX idx_users_email_tenant ON users (tenant_id, email);
CREATE INDEX idx_users_tenant ON users (tenant_id);
