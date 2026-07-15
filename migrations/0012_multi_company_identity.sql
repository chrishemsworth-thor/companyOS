-- Migration 0012: multi-company identity.
--
-- CompanyOS was already multi-tenant at the data layer, but the human-identity
-- layer (migration 0010) assumed one user = one tenant via a GLOBAL-unique
-- email, which meant a given email could exist in only one company and login
-- derived the tenant straight from the email row. This migration takes the
-- upgrade path 0010 documented: email becomes unique PER COMPANY, and tenants
-- gain a human-friendly `slug` so login can name the company (the workspace)
-- without exposing the opaque tenant_id.
--
-- Scope: one user still belongs to exactly one company. This does NOT introduce
-- cross-company membership — it just lets many companies coexist, each with its
-- own users, and lets the same email be reused across different companies.

-- Human-friendly company identifier used at login ("workspace"). Added as a
-- plain column first (SQLite can't add a UNIQUE column inline), backfilled for
-- existing rows, then covered by a unique index below.
ALTER TABLE tenants ADD COLUMN slug TEXT;

-- Backfill existing companies with a deterministic slug so they remain
-- loginable immediately. tenant_id is already unique, so it's a safe default;
-- operators can set a nicer slug later.
UPDATE tenants SET slug = tenant_id WHERE slug IS NULL;

CREATE UNIQUE INDEX idx_tenants_slug ON tenants (slug);

-- Email is now unique within a company, not globally. Drop the global index
-- (0010's idx_users_email) and replace it with a tenant-scoped one so the same
-- email can be an admin at Acme and a viewer at Globex — two distinct accounts.
DROP INDEX idx_users_email;
CREATE UNIQUE INDEX idx_users_email_tenant ON users (tenant_id, email);
