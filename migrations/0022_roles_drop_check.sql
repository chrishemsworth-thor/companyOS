-- Migration 0022: make the role vocabulary an application concern.
--
-- `users.role` carried `CHECK (role IN ('admin','operator','finance','support',
-- 'readonly'))`. SQLite cannot alter a CHECK in place, so every future role
-- would have cost a full table rebuild. PRD-008 spends that rebuild once, here,
-- to drop the constraint entirely: `src/auth/roles.ts` becomes the single source
-- of truth (it already is for the app — Zod validates writes with
-- `z.enum(ROLES)`), and adding a role never touches D1 again.
--
-- No row changes: the five existing roles keep their exact values, so no user
-- gains or loses access from this migration. What changes their effective
-- access is the capability matrix (`src/auth/capabilities.ts`) now being
-- enforced on every route — documented in docs/prd/PRD-008.
--
-- ============================================================================
-- WHY THIS IS SHAPED SO ODDLY
-- ============================================================================
--
-- The first version of this migration did the textbook rebuild: create
-- `users_new`, copy, `DROP TABLE users`, rename. It worked on a fresh database
-- and in CI, and **failed on every database that had real data in it**:
--
--   FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY
--
-- D1 will not drop a table while rows in other tables reference it, and there
-- is no way to suspend that from inside a migration. All four escape hatches
-- were tried against local D1 and none work:
--
--   * `PRAGMA defer_foreign_keys = on` — the version this replaces relied on
--     this. It does defer, but the violation the DROP raises is never cleared
--     by the later rename, so the transaction fails at COMMIT instead. Touching
--     the child rows afterwards to force a recheck does not clear it either.
--   * `PRAGMA foreign_keys = off` — silently ignored; D1 keeps enforcement on.
--   * `PRAGMA legacy_alter_table = on` — silently ignored.
--   * `PRAGMA writable_schema = on` — returns SQLITE_AUTH.
--
-- So the rows referencing `users` have to genuinely not exist at the moment it
-- is dropped. Foreign keys are checked per ROW, not per table definition, which
-- is the lever: a child table whose FK column is NULL — or which has no rows —
-- does not object to its parent disappearing. Every referencing column is
-- therefore emptied first and restored afterwards.
--
-- `users` is referenced from seven places. They fall into three groups:
--
--   1. **Ephemeral, deleted and not restored** — `sessions` and `user_tokens`.
--      Both are NOT NULL, so they cannot be nulled, and both are disposable by
--      nature: a session is a login and a token is a single-use invite or
--      password-reset link. Everyone is signed out by this migration and any
--      unclicked invite or reset link stops working; those links are reissued
--      from the console, and a re-login costs nothing. This is the "cheap"
--      trade in exchange for not rebuilding half the schema.
--
--   2. **Nullable, stashed and restored** — `employees.user_id`,
--      `google_accounts.user_id`, `google_accounts.connected_by_user_id`. The
--      values go into a temporary table, the columns are nulled, and the values
--      go back at the end. The rows themselves are never touched, so nothing
--      that references *them* is disturbed. That matters: `employees` is
--      referenced by `teams` and `google_accounts` by `delivery_config`, and
--      rebuilding either would have cascaded into those tables — and
--      `employees`/`teams` reference each other, which makes that cascade
--      genuinely nasty.
--
--   3. **NOT NULL but small and unreferenced** — `approvals`
--      (`approver_user_id`). It cannot be nulled, so the rows are copied out,
--      deleted, and copied back. Nothing references `approvals`, so emptying it
--      briefly is safe, and its own schema and indexes survive untouched.
--
-- `files.uploaded_by` looks like a fourth case and is not: it is plain TEXT with
-- no FK, deliberately (see 0021). `notifications` and `approval_nudges` DO
-- reference `users`, but they are created by 0023, which runs after this — if
-- this migration is ever reordered ahead of another table that references
-- `users`, that table has to be added to one of the groups above.
--
-- Everything below runs inside the single transaction wrangler wraps each
-- migration file in, so a failure at any point rolls back to the starting state
-- rather than leaving data parked in the `_mig22_*` tables.

-- ---------------------------------------------------------------------------
-- 1. Ephemeral children: delete, do not restore.
-- ---------------------------------------------------------------------------

-- Signs everyone out. KV still holds session lookup copies until they expire,
-- but this table is the source of truth for revocation, so those are dead.
DELETE FROM sessions;
-- Unclicked invite and password-reset links stop working; reissue from the
-- console. Keeping them would mean a live token pointing at a user row this
-- migration is about to rewrite.
DELETE FROM user_tokens;

-- ---------------------------------------------------------------------------
-- 2. Nullable children: stash the values, null the columns.
-- ---------------------------------------------------------------------------

-- Only rows that actually carry a link are stashed, so the restore at the end
-- is a no-op on a fresh database.
CREATE TABLE _mig22_employees AS
  SELECT tenant_id, employee_id, user_id FROM employees WHERE user_id IS NOT NULL;
-- `idx_employees_user` is UNIQUE on (tenant_id, user_id); SQLite treats NULLs as
-- distinct, so nulling every row cannot collide.
UPDATE employees SET user_id = NULL WHERE user_id IS NOT NULL;

CREATE TABLE _mig22_google_accounts AS
  SELECT account_id, user_id, connected_by_user_id FROM google_accounts
   WHERE user_id IS NOT NULL OR connected_by_user_id IS NOT NULL;
-- Same NULL-distinctness argument for the partial unique index on
-- (tenant_id, user_id) WHERE kind = 'user'.
UPDATE google_accounts
   SET user_id = NULL, connected_by_user_id = NULL
 WHERE user_id IS NOT NULL OR connected_by_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. NOT NULL child: copy out, empty, copy back at the end.
-- ---------------------------------------------------------------------------

CREATE TABLE _mig22_approvals AS SELECT * FROM approvals;
DELETE FROM approvals;

-- ---------------------------------------------------------------------------
-- 4. The actual point of the migration: rebuild `users` without the CHECK.
--
-- Nothing has a row pointing at `users` now, so the DROP is legal. The child
-- FK clauses still name `users`; they dangle for two statements and resolve
-- again the moment the new table takes the name.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 5. Put the referencing values back. Every user_id restored here was copied
--    from `users` above, so each one resolves against the new table.
-- ---------------------------------------------------------------------------

UPDATE employees
   SET user_id = (
     SELECT m.user_id FROM _mig22_employees m
      WHERE m.tenant_id = employees.tenant_id AND m.employee_id = employees.employee_id
   )
 WHERE EXISTS (
     SELECT 1 FROM _mig22_employees m
      WHERE m.tenant_id = employees.tenant_id AND m.employee_id = employees.employee_id
   );

UPDATE google_accounts
   SET user_id = (
         SELECT m.user_id FROM _mig22_google_accounts m
          WHERE m.account_id = google_accounts.account_id
       ),
       connected_by_user_id = (
         SELECT m.connected_by_user_id FROM _mig22_google_accounts m
          WHERE m.account_id = google_accounts.account_id
       )
 WHERE EXISTS (
     SELECT 1 FROM _mig22_google_accounts m
      WHERE m.account_id = google_accounts.account_id
   );

INSERT INTO approvals
  (approval_id, tenant_id, subject_type, subject_id, requested_by, approver_user_id,
   state, decision_comment, decided_by, decided_at, created_at, idempotency_key)
SELECT
   approval_id, tenant_id, subject_type, subject_id, requested_by, approver_user_id,
   state, decision_comment, decided_by, decided_at, created_at, idempotency_key
FROM _mig22_approvals;

DROP TABLE _mig22_employees;
DROP TABLE _mig22_google_accounts;
DROP TABLE _mig22_approvals;
