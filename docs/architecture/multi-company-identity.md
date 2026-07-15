# CompanyOS — Multi-Company Identity & Provisioning

*Last updated: 2026-07-15 · Status: **implemented***

How CompanyOS runs **many companies on one platform**, each fully isolated,
with a runtime way to onboard new ones. This is the identity + provisioning
layer added on top of the data-layer multi-tenancy that already existed.

Source: `migrations/0012_multi_company_identity.sql`, `src/auth/tenants.ts`,
`src/gateway/routes/platform.ts`, `src/gateway/routes/auth.ts`,
`src/auth/users.ts`. Tests: `test/multi-company.test.ts`.

---

## 1. What was already true (and what wasn't)

CompanyOS was multi-tenant **at the data layer** from Phase 0: every table is
keyed by `tenant_id` (composite PKs), each tenant has its own API key
(`api_key_hash`), and agents get a per-tenant Durable Object. What assumed a
*single* company was the **human identity layer** (migration 0010):

- `users.email` was **globally unique** — an email could exist in only one
  company across the whole platform.
- Login derived the tenant straight from the email row, so there was no way to
  say *which* company you were signing into.
- There was **no runtime path to create a company** — tenants only appeared via
  the local seed script.

This layer removes all three limits while keeping one invariant: **one user
still belongs to exactly one company.** It does *not* introduce cross-company
membership — it just lets many companies coexist and lets the same email be
reused as a distinct account at different companies.

## 2. Schema change — migration 0012

Two changes, both additive/index-level (no data rewrite beyond a backfill):

- **`tenants.slug`** — a human-friendly *workspace* identifier used at login so
  the opaque `tenant_id` never has to be typed. Added as a plain column (SQLite
  can't add a `UNIQUE` column inline), backfilled to `tenant_id` for existing
  rows so they stay loginable, then covered by `UNIQUE INDEX idx_tenants_slug`.
- **Per-company email uniqueness** — drop the global `idx_users_email` (from
  0010) and replace it with `idx_users_email_tenant` on `(tenant_id, email)`.
  The same address can now be an admin at Acme *and* a viewer at Globex — two
  independent accounts.

```
tenants:  + slug TEXT            UNIQUE (idx_tenants_slug)
users:    idx_users_email  →  idx_users_email_tenant (tenant_id, email)
```

The migration file documents this as the upgrade path 0010 anticipated; it is
the next sequential migration and never edits an applied one.

## 3. Tenant service — `src/auth/tenants.ts`

The root of onboarding a company. Same key-handling discipline as everywhere
else: the plaintext API key is shown once at creation, only its SHA-256 hash is
stored.

- **`createTenant(db, {name, slug})`** → `{tenant, api_key}`. Generates a
  `biz_<ulid>` id and a prefixed high-entropy `cos_…` key, normalizes the slug,
  inserts, and returns the public tenant + plaintext key once.
- **`normalizeSlug(input)`** — lowercases/trims and enforces `SLUG_RE`
  (`^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$`): 1–50 chars, lowercase
  alphanumerics with internal hyphens. Invalid → `TenantError('invalid_slug', 400)`.
- **`resolveTenantBySlug` / `getTenantBySlug`** — slug → tenant lookup (login
  and provisioning read paths).
- **`listTenants`** — all companies, ordered by `created_at` (operational
  visibility).
- **`TenantError`** — typed codes `slug_taken` (409), `invalid_slug` (400),
  `not_found` (404). A slug collision surfaces from the unique index and is
  mapped to `slug_taken`.

## 4. Provisioning API — `src/gateway/routes/platform.ts`

An internal/admin surface for onboarding *whole companies*. It is **not**
tenant-scoped (it operates across the platform), so it is mounted at `/admin`
in `src/index.ts` **before** the `/v1/*` `authenticate()` guard and carries its
own gate.

- **`requirePlatformAdmin()`** — every `/admin` route requires
  `Authorization: Bearer <PLATFORM_ADMIN_SECRET>`, compared in constant time.
  **Fails closed:** if `PLATFORM_ADMIN_SECRET` is unset the API returns `503`
  (a misconfigured deploy can't silently expose company creation); a
  missing/wrong token returns `401`.
- **`POST /admin/tenants`** — Zod-validated `{name, slug, admin_email,
  admin_password, admin_display_name?}`. Creates the tenant, then its first
  admin user (`role: "admin"`). **Atomic enough:** if admin creation fails the
  tenant is rolled back (`DELETE FROM tenants …`) so no orphaned, unloginable
  company is left behind. Returns `201 {tenant, api_key, admin}` — the API key
  shown exactly once.
- **`GET /admin/tenants`** — lists all companies.

`PLATFORM_ADMIN_SECRET` lives in `src/env.ts`; `wrangler.jsonc` carries a
dev-only placeholder so local dev/tests work, and production overrides it via
`wrangler secret put PLATFORM_ADMIN_SECRET`.

## 5. Workspace-scoped login — `src/gateway/routes/auth.ts`

Login now names the company. `loginSchema` is `{workspace, email, password}`:

1. `resolveTenantBySlug(workspace)` → the company.
2. **Unknown workspace is reported *identically* to bad credentials** (`401`,
   `code: invalid_credentials`) so login can't be used to enumerate which
   companies exist on the platform.
3. `authenticateUser(tenant_id, email, password)` — tenant-scoped (see below).
4. On success, create a server-side session and set the HttpOnly cookie; the
   response carries `{user, csrf_token, tenant_id, tenant}`.

`src/auth/users.ts` is tenant-scoped to match: `createUser`'s duplicate check is
`WHERE tenant_id = ? AND email = ?`, and `authenticateUser` takes a resolved
`tenant_id` and only matches within it.

## 6. Operator console

- **`AuthContext`** already fetched the tenant on `/v1/auth/me`; it now keeps it
  in state (`AuthTenant {tenant_id, name}`).
- **Login page** gained a **Company workspace** field alongside email/password.
- **Sidebar** shows the active company name in its footer, so an operator always
  knows which company they're in.

## 7. Local onboarding

The seed script (`scripts/seed-local.mjs`) sets a slug (`test-sme`) and prints
the workspace to log in with. Additional companies are created at runtime:

```sh
curl -X POST http://localhost:8787/admin/tenants \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Inc","slug":"acme","admin_email":"admin@acme.com","admin_password":"a-strong-password"}'
```

See [`../running-locally.md`](../running-locally.md) and
[`../testing/multi-company-department-test-plan.md`](../testing/multi-company-department-test-plan.md)
for the full local flow and a step-by-step test plan (migration apply, isolation
checks, workspace login).

## 8. Isolation guarantees & scope

- **Data isolation** is unchanged and total: every query is `tenant_id`-scoped,
  so an API key or session for one company never sees another's rows.
- **Identity isolation** is the new part: emails, sessions, and the workspace
  slug are all per-company.
- **Invariant kept:** a user maps to exactly one company. Cross-company
  membership (one human, many companies) is explicitly *not* modeled here and
  would be a future change to the `users` ↔ `tenants` relationship.

## 9. Tests

`test/multi-company.test.ts` covers: provisioning auth gating (missing/wrong
secret → 401), two companies sharing an admin email each loginable by its own
workspace, workspace-scoped login, unknown-workspace rejection (no
enumeration), duplicate-slug rejection (409), and cross-company data isolation
across API-key callers.
