# Test Plan — Multi-Company & Multi-Department (local, macOS)

Covers the two latest merges to `main`:

| PR | Feature | Schema? |
|---|---|---|
| **#14** `claude/companyos-multi-company-36kwe1` | Run many companies on one platform: workspace-slug login, per-company email uniqueness, `/admin/tenants` provisioning | **Yes — migration `0012`** |
| **#15** `claude/multi-department-modules-h1hupk` | Department-as-lens layer over capability modules: `GET /v1/meta/departments` + role-filtered sidebar / `/departments` overview | No |

Goal: verify the DB migration applies cleanly and both features work end-to-end
on your Mac — backend (curl) and operator console (browser).

---

## 0. Prerequisites

- **Node.js 18+** and **npm** (`node -v`).
- No Cloudflare account needed — `wrangler dev` runs a local runtime (miniflare)
  with a local D1 + KV.
- Three terminal tabs: **(1)** Worker, **(2)** curl/seed, **(3)** UI.
- Always use `localhost` (not `127.0.0.1`) — the session cookie is host-scoped
  and the dev CORS allowlist expects the console origin to match.

Dev secrets ship as placeholders in `wrangler.jsonc` (no setup needed):
- `PLATFORM_ADMIN_SECRET` = `dev-insecure-platform-admin-secret-change-me`
- `SESSION_SECRET` = `dev-insecure-session-secret-change-me`

```sh
git checkout claude/multi-company-dept-testing-okozfo   # or main — both contain #14 + #15
git pull
npm install
```

---

## 1. Part A — Database migration (`0012_multi_company_identity`)

This is the only new schema change. It (a) adds `tenants.slug` (unique,
backfilled from `tenant_id`), and (b) swaps user-email uniqueness from **global**
(`idx_users_email`) to **per-company** (`idx_users_email_tenant`).

### A1. Clean apply from scratch

```sh
rm -rf .wrangler                 # wipe any existing local D1/KV state (fresh DB)
npm run db:migrate:local         # applies 0001 … 0012 in order
```

**Expect:** all 12 migrations report applied, `0012_multi_company_identity.sql`
included, no errors.

### A2. Verify the schema landed

```sh
# slug column + unique index on tenants
npx wrangler d1 execute companyos-db --local \
  --command "SELECT name FROM pragma_table_info('tenants') WHERE name='slug';"

# the per-tenant email index exists and the old global one is gone
npx wrangler d1 execute companyos-db --local \
  --command "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_users_email','idx_users_email_tenant');"
```

**Expect:** `slug` present; `idx_users_email_tenant` present; `idx_users_email`
**absent** (dropped by 0012).

### A3. Migration is not re-applied (idempotent runner)

```sh
npm run db:migrate:local         # run again
```

**Expect:** "No migrations to apply" (or equivalent) — 0012 is not re-run.

> ⚠️ Order matters: `db:migrate:local` **must** run before any seed, or `users`
> / `tenants.slug` won't exist yet.

### A4. (Optional) Verify the backfill on a pre-0012 database

Only if you want to prove the upgrade path (existing companies stay loginable):

```sh
rm -rf .wrangler
# apply everything EXCEPT 0012 by temporarily moving it aside
mv migrations/0012_multi_company_identity.sql /tmp/0012.sql
npm run db:migrate:local
npx wrangler d1 execute companyos-db --local \
  --command "INSERT INTO tenants (tenant_id, name, api_key_hash) VALUES ('biz_legacy','Legacy Co','deadbeef');"
# now bring 0012 back and migrate
mv /tmp/0012.sql migrations/0012_multi_company_identity.sql
npm run db:migrate:local
npx wrangler d1 execute companyos-db --local \
  --command "SELECT tenant_id, slug FROM tenants WHERE tenant_id='biz_legacy';"
```

**Expect:** `slug` for the legacy row is backfilled to `biz_legacy` (equals its
`tenant_id`), so the company remains resolvable at login. **Reset afterward:**
`rm -rf .wrangler && npm run db:migrate:local`.

---

## 2. Start the stack

**Terminal 1 — Worker:**
```sh
npm run dev                      # http://localhost:8787
```

**Terminal 2 — seed the first company:**
```sh
npm run seed:local
```
Prints a `tenant_id`, a **workspace slug** (`test-sme`), a plaintext **API key**
(copy it), and the operator login:
```
workspace: test-sme
email:     admin@example.com
password:  companyos-admin
```

Optionally load a realistic dataset (used later for isolation checks):
```sh
npm run seed:sample -- --api-key <printed_api_key>
```

**Terminal 3 — operator console:**
```sh
cd ui && npm install && npm run dev   # http://localhost:5173
```

---

## 3. Part B — Multi-company (PR #14)

Set a shell var for convenience:
```sh
ADMIN_SECRET='dev-insecure-platform-admin-secret-change-me'
```

### B1. Provisioning API is gated (fail-closed)

```sh
# no auth → 401
curl -i -X POST http://localhost:8787/admin/tenants \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme","slug":"acme","admin_email":"a@acme.com","admin_password":"strong-pass-1"}'

# wrong token → 401
curl -i -X POST http://localhost:8787/admin/tenants \
  -H "Authorization: Bearer nope" -H "Content-Type: application/json" \
  -d '{"name":"Acme","slug":"acme","admin_email":"a@acme.com","admin_password":"strong-pass-1"}'
```
**Expect:** both `401 unauthorized`. (If `PLATFORM_ADMIN_SECRET` were unset you'd
get `503` — fail closed.)

### B2. Create two companies

```sh
# Company 1: Acme
curl -s -X POST http://localhost:8787/admin/tenants \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"name":"Acme Inc","slug":"acme","admin_email":"admin@shared.com","admin_password":"strong-pass-1"}'
echo
# Company 2: Globex — SAME admin email, different workspace
curl -s -X POST http://localhost:8787/admin/tenants \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"name":"Globex LLC","slug":"globex","admin_email":"admin@shared.com","admin_password":"strong-pass-2"}'
echo
```
**Expect:** each returns `201` with `{ tenant: {tenant_id, name, slug, created_at}, api_key, admin }`.
Save both `api_key` values (`ACME_KEY`, `GLOBEX_KEY`) — shown only once.

### B3. List companies

```sh
curl -s http://localhost:8787/admin/tenants -H "Authorization: Bearer $ADMIN_SECRET"
```
**Expect:** `test-sme`, `acme`, `globex` all present.

### B4. Slug validation & duplicate rejection

```sh
# duplicate slug → 409 slug_taken
curl -i -X POST http://localhost:8787/admin/tenants \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"name":"Acme Dup","slug":"acme","admin_email":"x@acme.com","admin_password":"strong-pass-9"}'

# invalid slug (uppercase/space) → 400 invalid_slug
curl -i -X POST http://localhost:8787/admin/tenants \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"name":"Bad","slug":"Bad Slug","admin_email":"x@bad.com","admin_password":"strong-pass-9"}'
```
**Expect:** `409` (`code: slug_taken`) and `400` (`code: invalid_slug`) respectively.

### B5. Workspace-scoped login + same email, two companies

```sh
# Log in as admin@shared.com at ACME
curl -s -c acme.txt -X POST http://localhost:8787/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"workspace":"acme","email":"admin@shared.com","password":"strong-pass-1"}'
echo
# Same email at GLOBEX with GLOBEX's password
curl -s -c globex.txt -X POST http://localhost:8787/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"workspace":"globex","email":"admin@shared.com","password":"strong-pass-2"}'
echo
```
**Expect:** both `200`, each response's `tenant_id` differs — the same email is
two independent accounts. Cross-check that Acme's password fails at Globex:
```sh
curl -i -X POST http://localhost:8787/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"workspace":"globex","email":"admin@shared.com","password":"strong-pass-1"}'
```
**Expect:** `401 invalid_credentials`.

### B6. Unknown workspace is indistinguishable from bad credentials

```sh
curl -i -X POST http://localhost:8787/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"workspace":"does-not-exist","email":"admin@shared.com","password":"strong-pass-1"}'
```
**Expect:** `401` with the **same** `invalid_credentials` body as a bad password
(no company enumeration).

### B7. Cross-company data isolation (API-key path)

Create a customer in each company, then confirm neither key sees the other's:
```sh
ACME_KEY=<acme api_key>;  GLOBEX_KEY=<globex api_key>
curl -s -X POST http://localhost:8787/v1/customers -H "Authorization: Bearer $ACME_KEY" \
  -H "Content-Type: application/json" -d '{"name":"Acme-only Customer"}'; echo
curl -s -X POST http://localhost:8787/v1/customers -H "Authorization: Bearer $GLOBEX_KEY" \
  -H "Content-Type: application/json" -d '{"name":"Globex-only Customer"}'; echo

curl -s http://localhost:8787/v1/customers -H "Authorization: Bearer $ACME_KEY";   echo
curl -s http://localhost:8787/v1/customers -H "Authorization: Bearer $GLOBEX_KEY"; echo
```
**Expect:** Acme's list shows only "Acme-only Customer"; Globex's shows only
"Globex-only Customer". No bleed-through.

### B8. UI login with workspace (browser)

1. Open http://localhost:5173 — the login form now has a **Company workspace**
   field (plus Email, Password, API base URL).
2. Sign in with `acme` / `admin@shared.com` / `strong-pass-1`.
3. **Expect:** dashboard loads; the sidebar footer/header shows the active
   company (**Acme Inc**).
4. Sign out, sign in as `globex` / `admin@shared.com` / `strong-pass-2` →
   **Expect:** now shows **Globex LLC**, and none of Acme's data is visible.
5. Try a bad workspace (`nope`) → **Expect:** "Invalid email or password."

### B9. Post-login smoke — the page actually renders (blank-page guard)

Right after any successful UI login, confirm the app *painted* — not just that
login returned 200. (A `200` login with a **blank page** means the React shell
threw during render; see the note below.)

**Expect, immediately after sign-in:**
- The main content area shows the **Dashboard** (KPI tiles), not an empty page.
- The **left sidebar** renders: an *Overview* group with **Departments**, one
  group per live department (Finance, Sales…), a *Planned* group with disabled
  "Soon" items, and the active **company name** in the footer.
- Browser devtools **Console** has no uncaught `ReferenceError` / render error,
  and the tab is not blank.

> **Known regression this guards against:** the department sidebar
> (`ui/src/components/Layout.tsx`) once referenced identifiers removed in the
> department-lens merge, throwing at render and blanking the page right after a
> successful login. Fixed by driving the sidebar off `departmentsForRole()`.
> The automated guard is `ui/src/components/Layout.test.tsx` (Part D) — if it's
> green, the shell mounts; if the browser still blanks, hard-refresh (Vite HMR)
> and check the Console.

---

## 4. Part C — Multi-department (PR #15)

No schema change — this is a lens over existing modules. 11 departments total:
**6 live** (Finance, Sales & Business Development, Customer Experience,
Technology/Engineering, Data & AI, Management) and **5 planned** (Product,
R&D/Innovation, People, Legal, Operations).

### C1. Agent / API-key caller sees the full taxonomy

```sh
curl -s http://localhost:8787/v1/meta/departments -H "Authorization: Bearer $ACME_KEY"
```
**Expect:** `departments` array of **11** entries, each with `id`, `label`,
`status` (`live`/`planned`), `modules`, `roles`, `tools`. Planned ones have
`tools: []`.

### C2. Endpoint requires authentication

```sh
curl -i http://localhost:8787/v1/meta/departments
```
**Expect:** `401` (no API key / no session).

### C3. Human sessions are role-filtered

The list is filtered to the caller's role. Create scoped users (as an admin) to
check each lens. Via the console **Users** page (or `POST /v1/users`), create:
- a **finance**-role user, and
- a **support**-role user,

in the `acme` workspace, then hit the endpoint with their session cookie:

```sh
# log in as the finance user (replace creds), save cookie
curl -s -c fin.txt -X POST http://localhost:8787/v1/auth/login -H "Content-Type: application/json" \
  -d '{"workspace":"acme","email":"finance@acme.com","password":"<pwd>"}' >/dev/null
curl -s -b fin.txt http://localhost:8787/v1/meta/departments | grep -o '"id":"[a-z-]*"'
```

**Expect (role → visible departments):**

| Role | Departments returned |
|---|---|
| `admin`, `operator`, `readonly` | all 11 |
| `finance` | **Finance + Management** only (2) |
| `support` | **Customer Experience** only (1) |
| unknown/invalid role | empty list (no leak) |

### C4. Sidebar grouped by department (browser)

Sign in to the console (any BROAD-role user, e.g. the admin):
1. **Expect:** left nav is grouped by department heading, not a flat list.
2. **Planned** departments (Product, R&D, People, Legal, Operations) appear
   **disabled** (visible but not clickable).
3. Each live department's tools route correctly (Finance → Invoices/Ledger,
   Sales → Customers/Deals, Customer Experience → Tickets, Technology →
   Projects/Issues, Data & AI → Agent activity, Management → Dashboard).

### C5. `/departments` overview page

Navigate to **/departments** in the console.
**Expect:** an overview listing all departments with status + summary, matching
what `GET /v1/meta/departments` returns for your role (the UI mirror in
`ui/src/lib/departments.ts` is kept in sync with the server registry by a parity
test — see C6).

---

## 5. Part D — Automated suites (fast regression, no browser)

Run the same suites CI runs; both features have dedicated tests:

```sh
npm test            # backend — includes test/multi-company.test.ts + test/departments.test.ts
cd ui && npm test   # UI — includes ui/src/lib/departments.test.ts (server⇄UI parity)
cd .. && npm run typecheck
(cd ui && npm run typecheck)
```

**Expect:** all green. Key files to watch:
- `test/multi-company.test.ts` — provisioning auth gating, same email across two
  companies, workspace-scoped login, unknown-workspace rejection, duplicate-slug
  rejection, cross-company isolation.
- `test/departments.test.ts` — registry invariants (11 departments, valid roles,
  live depts have real routes), `departmentsForRole` scoping, and the
  `GET /v1/meta/departments` role-filter behavior.
- `ui/src/lib/departments.test.ts` — parity between the UI mirror and the server
  registry (fails if the two drift).
- `ui/src/components/Layout.test.tsx` — **blank-page guard**: mounts the
  authenticated shell and asserts the dashboard + department sidebar render, so a
  render-time crash after login fails the suite instead of blanking the browser
  (see B9).

> The **UI typecheck** (`cd ui && npm run typecheck`) is the cheapest guard here
> and catches this class of bug outright — the blank-page crash was an undefined
> reference that `tsc` flags immediately. Treat it as a required gate before
> shipping UI changes; `npm run build` runs it too.

---

## 6. Sign-off checklist

**Migration**
- [ ] A1 all 12 migrations apply clean from a wiped `.wrangler`
- [ ] A2 `slug` column + `idx_users_email_tenant` present; `idx_users_email` gone
- [ ] A3 re-run is a no-op
- [ ] A4 (optional) legacy tenant backfilled with slug = tenant_id

**Multi-company**
- [ ] B1 `/admin/tenants` rejects missing/wrong secret (401)
- [ ] B2 two companies created (201, api_key returned once)
- [ ] B4 duplicate slug → 409; invalid slug → 400
- [ ] B5 same email logs into both companies with different tenant_ids
- [ ] B6 unknown workspace → 401 identical to bad creds
- [ ] B7 API-key data isolation holds
- [ ] B8 UI workspace login switches companies correctly
- [ ] B9 post-login page renders (dashboard + sidebar; no blank page / console error)

**Multi-department**
- [ ] C1 API key sees all 11 departments
- [ ] C2 endpoint requires auth (401)
- [ ] C3 finance→2, support→1, BROAD→11, unknown→0
- [ ] C4 sidebar grouped; planned disabled; tools route
- [ ] C5 `/departments` overview renders

**Regression**
- [ ] D backend + UI suites + both typechecks green

---

### Reset between runs
Wipe local DB/KV and re-migrate/re-seed:
```sh
rm -rf .wrangler && npm run db:migrate:local && npm run seed:local
```
