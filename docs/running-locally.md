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

## Approvals & notifications (PRD-000b/c + PRD-007)

**Read this before hunting for a bug.** There is deliberately **no
`POST /v1/approvals`** — the approvals primitive is an internal service that
consuming modules call, because an approval must point at a real subject (a claim,
a leave request) and letting a client conjure one would create approvals pointing
at nothing. And the modules that *would* create them — expense claims (S5), leave
requests (S7), quote sign-off (S9) — are not built yet.

So on a fresh local database `/approvals` is legitimately empty and the bell shows
zero. That is correct behaviour, not a broken build. To see the screens with data,
insert an approval directly and then drive the rest through the real API.

### Expect a ~5 second delay on the badge

The plain `npm run dev` works — miniflare runs the queue consumer locally, so
notifications do get written. But `wrangler.jsonc` sets
`max_batch_timeout: 5` on the consumer, so the queue waits up to **five seconds**
to fill a batch before delivering. Nudge something and check the bell
immediately and you will see an empty feed and conclude it is broken. It is not;
wait five seconds and refetch.

If you would rather not have that delay while poking at this, run the free-plan
config instead, where there is no queue at all and events dispatch **inline**
through `src/queue/direct.ts` — the notification row is written before the API
call returns:

```sh
npx wrangler dev --config wrangler.free.jsonc
```

> **The two configs do not share a local database.** `wrangler.jsonc` and
> `wrangler.free.jsonc` declare different `database_id`s, and miniflare keys its
> local D1 state on that id. Migrating with `npm run db:migrate:local` (which
> reads `wrangler.jsonc`) and then serving with `--config wrangler.free.jsonc`
> gives you a Worker talking to an empty database, and every request 500s with
> `no such table: tenants`. If you use the free config, pass it to
> **everything** — `npx wrangler d1 migrations apply companyos-db --local
> --config wrangler.free.jsonc`, and the same flag on every `d1 execute` below.

### Seed one approval

Take the `usr_…` id of your logged-in admin and its `biz_…` tenant id:

```sh
npx wrangler d1 execute companyos-db --local \
  --command "SELECT user_id, tenant_id, email FROM users;"
```

Insert a pending approval that *you* raised, assigned to *you*:

```sh
npx wrangler d1 execute companyos-db --local --command "
  INSERT INTO approvals (approval_id, tenant_id, subject_type, subject_id,
                         requested_by, approver_user_id, state)
  VALUES ('apr_local_1', '<tenant_id>', 'expense_claim', 'clm_demo',
          '<user_id>', '<user_id>', 'pending');"
```

Reload the console. `/approvals` now shows it under **Awaiting me** *and* **My
requests**, rendered by the generic fallback card — which is the only renderer
that ships today, so every subject type takes it.

### Then drive the real chain

The nudge is the one path that produces a notification end to end over HTTP
today, and it exercises everything: service → rate limit → event → registry
validation → consumer → D1 → API → bell.

1. Open **My requests**, click **Nudge**. The bell badge goes to 1 — after up to
   five seconds on the default config (see above). The console polls every 60s,
   so switch route or reload rather than waiting for the poll.
2. Click **Nudge** again → blocked with "Already reminded" (the 24h cooldown,
   429 + `Retry-After: 86398`). This one is *immediate* on both configs, because
   the cooldown ledger is written synchronously by the request rather than by the
   consumer — which is exactly why it is its own table.
3. Open the bell → the reminder is grouped under **Reminders** and deep-links.
   Because `expense_claim` has no console screen until S5, it renders as
   "Opens in the approvals inbox" rather than linking nowhere — that is the
   designed fallback, not a dead link.
4. Click it → marked read, badge clears, and it stays cleared on refresh.
5. Back on **Awaiting me**, **Reject** with an empty comment → blocked inline.
   Add a comment and reject → the item leaves the list, and **History** shows it
   with the comment. A notification lands for the requester (you).
6. **Withdraw** a pending request from My requests → it disappears from Awaiting
   me (`state = cancelled`, no event and no notification — nobody decided
   anything, the subject simply went away).

Watch the `wrangler dev` log while you do this. Every notification write logs
through `[notifications]`, and a skipped one says why — a payload missing a
recipient warns rather than throwing, by design.

The same flow with curl, if you would rather not click (the whole sequence above
was verified this way):

```sh
# Log in, keeping the cookie and the CSRF token.
CSRF=$(curl -s -c /tmp/c.txt -X POST http://localhost:8787/v1/auth/login \
  -H "Content-Type: application/json" -H "Origin: http://localhost:5173" \
  -d '{"workspace":"test-sme","email":"admin@example.com","password":"companyos-admin"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['csrf_token'])")

# The queue: should list apr_local_1.
curl -s -b /tmp/c.txt "http://localhost:8787/v1/approvals?mine=true&state=pending"

# Nudge → 202. Then again → 429 with Retry-After.
curl -s -i -b /tmp/c.txt -X POST http://localhost:8787/v1/approvals/apr_local_1/nudge \
  -H "X-CSRF-Token: $CSRF" -H "Origin: http://localhost:5173"

# Wait ~5s on the default config, then the bell.
sleep 6 && curl -s -b /tmp/c.txt http://localhost:8787/v1/notifications

# Reject with a comment → the requester gets a notification carrying the comment
# as its body. Re-deciding then returns 409.
curl -s -b /tmp/c.txt -X POST http://localhost:8787/v1/approvals/apr_local_1/reject \
  -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
  -H "Origin: http://localhost:5173" -d '{"comment":"Receipt is illegible"}'
```

### Checking the rows directly

```sh
npx wrangler d1 execute companyos-db --local --command \
  "SELECT type, title, read_at FROM notifications ORDER BY notification_id DESC;"
npx wrangler d1 execute companyos-db --local --command \
  "SELECT approval_id, nudged_at FROM approval_nudges;"
```

To re-test the cooldown without waiting a day, backdate the ledger — it is the
only state the check reads:

```sh
npx wrangler d1 execute companyos-db --local --command \
  "UPDATE approval_nudges SET nudged_at = '2026-01-01T00:00:00.000Z';"
```

### Mobile

`/approvals` and the bell are the only part of the console with a hard mobile
requirement, and the tests cannot verify it — jsdom has no layout engine, so they
pin the responsive contract (no fixed widths, stacked full-width controls) rather
than measuring the result. **Open Safari or Chrome devtools at 375px** and check
an approval can be read and decided with no horizontal scrolling. This is the one
part of the feature that genuinely needs a human eye.

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
#    `workspace` is the tenant slug seed:local printed (default: test-sme) —
#    email is only unique within a company, so login needs all three.
curl -c cookies.txt -X POST http://localhost:8787/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"workspace":"test-sme","email":"admin@example.com","password":"companyos-admin"}'

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

- **`0022_roles_drop_check.sql` failed with `FOREIGN KEY constraint failed`**
  ("Durable Object was reset and rolled back…"). **Fixed** — pull `main` and
  re-run. If you are on an older checkout, the symptom appeared only on a
  database that already had data, which is why it passed on a fresh one and in
  CI.

  Worth knowing for the next time somebody rebuilds a table: **D1 will not drop a
  table while rows in other tables reference it**, and there is no way to suspend
  that from inside a migration. Four escape hatches were tried and none work —
  `PRAGMA defer_foreign_keys` defers but then fails at COMMIT (the violation the
  DROP raises is never cleared by the later rename), `foreign_keys = off` and
  `legacy_alter_table` are both silently ignored, and `writable_schema` returns
  `SQLITE_AUTH`.

  What does work is making the referencing rows genuinely not exist at the moment
  of the drop, because foreign keys are checked per **row**, not per table
  definition. 0022 now deletes the ephemeral children (`sessions`, `user_tokens`
  — everyone is signed out and unclicked invite/reset links stop working), stashes
  and nulls the nullable ones (`employees.user_id`, both `google_accounts`
  columns), and copies `approvals` out and back because its `approver_user_id` is
  NOT NULL. No other table is rebuilt, which is what keeps the change from
  cascading into `teams` and `delivery_config` — and `employees`/`teams`
  reference each other, so that cascade would have been genuinely unpleasant.

  A useful property of the rebuild, if you ever need it: renaming the new table
  into the old name makes SQLite rewrite every child FK that pointed at the
  temporary name, so the references follow automatically.

  Verified on a populated database through `wrangler d1 migrations apply` — all
  values restored, indexes recreated, FKs still enforced.
  `test/migration-roles-drop-check.test.ts` pins the resulting properties, though
  note it cannot test the migration's data preservation: `applyD1Migrations` runs
  against an empty database, which is precisely the blind spot that let the
  original bug through.

  To reset local state anyway (it is disposable):

  ```sh
  rm -rf .wrangler/state/v3/d1
  npm run db:migrate:local
  npm run seed:local            # re-seed; the old tenant and users are gone
  ```
