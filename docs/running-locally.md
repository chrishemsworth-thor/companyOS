# Running CompanyOS locally

How to run the Worker (API + agents) and the operator console on your machine,
and exercise the human-facing features: session login, users & roles, the
insights dashboard, ledger journal entries + reversals, and multi-invoice
payments. Agents keep the tenant-API-key path; humans sign in with email +
password.

## Prerequisites

- Node.js 18+ and npm.
- No Cloudflare account needed for local dev — `wrangler dev` runs the Worker in
  a local runtime (miniflare) with a local D1 database and KV.

Use **`localhost`** consistently everywhere (not `127.0.0.1`): the session
cookie is host-scoped and the dev CORS allowlist (`ALLOWED_ORIGINS` in
`wrangler.jsonc`) expects the console's origin to match.

## 1. Backend — the Worker (terminal 1)

```sh
npm install
npm run db:migrate:local     # apply D1 migrations (incl. 0010 users/sessions, 0011 actor cols)
npm run dev                  # wrangler dev on http://localhost:8787
```

`wrangler dev` reads `wrangler.jsonc`, which ships with dev-only defaults so this
works with no extra setup: a placeholder `SESSION_SECRET` var, `ALLOWED_ORIGINS`
(`http://localhost:5173`), the `SESSIONS` KV binding, and the `nodejs_als`
compatibility flag (needed for per-user audit attribution). miniflare creates the
local `SESSIONS` KV automatically.

> Production differs: set a real `SESSION_SECRET` via `wrangler secret put` and
> point `ALLOWED_ORIGINS` at your console's real origin. See the README's
> Deploying section.

## 2. Seed a tenant + first operator (terminal 2)

```sh
npm run seed:local
```

This prints three things:

- a **tenant id** (`biz_…`),
- a plaintext **API key** — for agents / programmatic access (curl), and
- a first **operator login** for the console:

  ```
  email:     admin@example.com
  password:  companyos-admin
  ```

Flags: `--tenant-id`, `--name`, `--api-key`, `--admin-email`, `--admin-password`.

Optionally populate a realistic dataset (customers, invoices in various states,
deals, tickets, a project with issues) so there's something to look at:

```sh
npm run seed:sample -- --api-key <printed_api_key>
```

> Order matters: run `db:migrate:local` **before** `seed:local`, otherwise the
> `users` table won't exist yet and the seed insert fails.

## 3. UI — the operator console (terminal 3)

```sh
cd ui
npm install
npm run dev                  # http://localhost:5173
```

Open **http://localhost:5173** and sign in with the seeded operator
(`admin@example.com` / `companyos-admin`). The API base-URL field defaults to
`http://localhost:8787`.

## What to exercise

- **Login / session** — you sign in with email + password; the tenant API key
  never touches the browser. "Sign out" clears the session.
- **Users** (admin-only nav item) — create an operator (no password field:
  the server issues a single-use invite link; with no email transport
  configured locally the modal shows the copyable URL and the Worker logs an
  `[email:console]` line). Open the invite link in a private window, set a
  password, and you land signed in. Then set a role to `readonly` and confirm
  writes are blocked and the Users page returns 403.
- **Forgot / reset password** — "Forgot password?" on the login page; the
  reset link appears in the Worker log (console email provider). The reset
  revokes every session for that user.
- **Dashboard** — the KPI tiles and the AR-aging table are served by
  `/v1/insights/summary` and `/v1/insights/ar-aging` (server-side aggregates).
- **Ledger** — the *Journal entries* table; open an entry → **Reverse entry**
  (append-only ledger, so corrections are reversals). Reversing a reversal is
  disabled.
- **Record payment** (from an invoice) — allocate one payment across several of
  a customer's outstanding invoices.

## Fast smoke test (no browser)

The suites run against the real Workers runtime and cover the full auth flow,
insights, and the ledger endpoints end-to-end:

```sh
npm test          # backend (Vitest + @cloudflare/vitest-pool-workers)
cd ui && npm test # UI (Vitest + Testing Library)
npm run typecheck # backend types;  (cd ui && npm run typecheck) for the UI
```

## Calling the API directly with curl

**Agent / programmatic path** — the tenant API key still works:

```sh
curl http://localhost:8787/v1/insights/summary \
  -H "Authorization: Bearer <api_key>"
```

**Human path** — log in for a session cookie, then send the CSRF token on writes:

```sh
# 1. Log in; save the cookie. The JSON response includes csrf_token.
curl -c cookies.txt -X POST http://localhost:8787/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"companyos-admin"}'

# 2. Read the current user (rides the cookie).
curl -b cookies.txt http://localhost:8787/v1/auth/me

# 3. A write needs the X-CSRF-Token header (use the csrf_token from step 1).
curl -b cookies.txt -X POST http://localhost:8787/v1/customers \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <csrf_token>" \
  -d '{"name":"Acme Sdn Bhd"}'
```

## Troubleshooting

- **Login says invalid credentials** — re-run `npm run seed:local` (re-seeding
  resets the admin password) and check migrations were applied.
- **Browser writes fail with 403** — the UI attaches the CSRF token automatically;
  a 403 usually means the session expired (sign in again) or the console origin
  isn't in `ALLOWED_ORIGINS`.
- **Requests blocked by CORS** — make sure you're using `http://localhost:5173`
  (the allowlisted origin), not `127.0.0.1`.
- **"table users has no column …" / missing table** — migrations weren't applied;
  run `npm run db:migrate:local`.
