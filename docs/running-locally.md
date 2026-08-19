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
at nothing.

On a fresh local database `/approvals` is empty and the bell shows zero. That is
correct, not a broken build: nothing has been filed yet. Two modules now raise
real approvals — **expense claims** (S5) and **leave requests** (S7); quote
sign-off (S9) is still to come — so the honest way to fill the screen is to file
something. [Filing real leave](#file-a-real-leave-request) below does that in
three curl calls and is the better demo, because it exercises the whole chain
including the purpose-built approval card. The hand-inserted row further down
still has its place: it is how you see the *generic fallback* card, which no
real subject takes any more.

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
  VALUES ('apr_local_1', '<tenant_id>', 'quote', 'qte_demo',
          '<user_id>', '<user_id>', 'pending');"
```

Reload the console. `/approvals` now shows it under **Awaiting me** *and* **My
requests**. Note the `subject_type` above is `quote` rather than `expense_claim`
on purpose: claims and leave requests both have purpose-built cards now, and a
card fetches its subject — point one at `clm_demo`, which does not exist, and you
get the card's unavailable state instead of the fallback you were trying to see.
`quote` has no renderer until S9, so it is what still exercises the generic card.

### File a real leave request

The better demo, and the one that exercises the two halves of the leave module
against each other. Everything below uses the tenant API key printed by
`npm run seed:local`.

```sh
K=<api_key>

# An employee. Leave is always ABOUT an employee, never about a user.
EID=$(curl -s -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"name":"Aisha Rahman","department_id":"operations","start_date":"2022-01-01"}' \
  http://localhost:8787/v1/people/employees \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['employee_id'])")

# What the employee is entitled to. Nothing was configured — S6 seeds the
# Malaysian defaults on first read, so this is real policy, not a placeholder.
curl -s -H "Authorization: Bearer $K" \
  "http://localhost:8787/v1/people/leave/balances?employee_id=$EID&as_of=2026-12-31"

# The working-day cost, BEFORE submitting. `entitlement_source` should read
# "policy"; "default" means the policy port fell back and something is wrong.
curl -s -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d "{\"employee_id\":\"$EID\",\"leave_type_code\":\"annual\",
       \"start_date\":\"2026-09-07\",\"end_date\":\"2026-09-09\"}" \
  http://localhost:8787/v1/leave/preview

# File it. This raises an approval and routes it up the reporting line.
curl -s -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d "{\"employee_id\":\"$EID\",\"leave_type_code\":\"annual\",
       \"start_date\":\"2026-09-07\",\"end_date\":\"2026-09-09\",
       \"reason\":\"Family trip\"}" \
  http://localhost:8787/v1/leave/requests
```

Now re-read the balance. `available_days` has dropped by three and
`pending_days` is three — **without anything decrementing a counter**. The
balance is derived on read, which is why a rejection restores it with no
compensating write.

That drop is also the load-bearing check on the S6/S7 merge. The two halves were
built concurrently and each keeps its own key for a leave type; the submit path
resolves and stores both, and this balance moving is the proof they are joined.
If `pending_days` stays at zero while the request exists, that link is broken —
see [`docs/modules/leave.md`](modules/leave.md#one-table-two-type-columns).

The employee has no manager here, so the approval falls back to a tenant admin —
you. Reload `/approvals` and the request is in **Awaiting me**, rendered by S7's
card with its dates, working days, the balance left after approval and any
overlapping team leave.

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
   Claims and leave requests link to their own detail screens; a subject type
   with no screen (`quote` until S9, or the generic `other`) renders as "Opens in
   the approvals inbox" rather than linking nowhere — the designed fallback, not
   a dead link.
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

## Contact roles, customer depth & health (PRD-003)

Three features from S8, in the order they are worth checking. Everything below
uses the tenant API key printed by `npm run seed:local` — set `K=<api_key>` and
`CUST=<a customer id>` first.

### Migration `0027` on an existing local database

`0027_crm_depth.sql` is the first migration since `0022` that **changes data
rather than only adding to it**: it backfills `contact_roles`, rewrites
`contacts.is_primary` from those roles, and then adds a unique index enforcing
one primary per customer. Nothing enforced that before, so a database with
duplicate primaries is possible.

It was verified against a populated database with all three pre-0027 shapes
(a customer with two primaries, one with none, one whose primary is not its
earliest contact) and resolves them rather than failing — so **you should not
need to wipe `.wrangler`**. If you want to see what it did:

```sh
npx wrangler d1 execute companyos-db --local --command "
SELECT c.customer_id, c.contact_id, c.is_primary,
       (SELECT group_concat(role) FROM contact_roles r WHERE r.contact_id = c.contact_id) AS roles
FROM contacts c ORDER BY c.customer_id, c.contact_id;"
```

Every customer with contacts should have exactly one `is_primary = 1`, and that
row should be the one holding `primary`. The two are one fact — see
[`modules/crm.md`](modules/crm.md) — and a row where they disagree means
something wrote `is_primary` directly instead of going through the service.

### Roles in the console

Open any customer. The contacts table has a **Roles** column, and **Add contact**
shows role checkboxes with **no** standalone "Primary contact" checkbox. That
removal is deliberate: one fact, one control.

1. Add "Ravi" with **Billing** ticked, then "Aina" with **Primary** ticked.
2. Edit Ravi and tick **Primary** — a line appears warning that this clears the
   current primary. Save.
3. Aina's primary badge is gone. Exactly one primary survives, and the join
   table agrees with the flag.

PRD-003 offered either atomic-clear or a 409 here and said to pick one; S8 picked
clear-atomically, last-write-wins, inside a single `db.batch()`.

### The claim worth checking: a reminder addresses the billing contact

This is what contact roles are *for*. Before S8, `sendReminder` read
`customers.email` and nothing else.

```sh
curl -s -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"name":"Aina","email":"aina@example.com","roles":["primary"]}' \
  http://localhost:8787/v1/customers/$CUST/contacts

curl -s -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"name":"Ravi","email":"ravi@example.com","roles":["billing"]}' \
  http://localhost:8787/v1/customers/$CUST/contacts

# The resolution chain over HTTP: requested role -> primary -> any -> null.
curl -s -H "Authorization: Bearer $K" \
  "http://localhost:8787/v1/customers/$CUST/contacts/resolve?role=billing"    # matched: "role"
curl -s -H "Authorization: Bearer $K" \
  "http://localhost:8787/v1/customers/$CUST/contacts/resolve?role=signatory"  # matched: "primary"
```

`matched` is not decoration — PRD-003 requires that a *fallback* be recorded on
the decision, so `"primary"` there means "nobody holds the role you asked for".

Now send a reminder and check who it actually reached. Note the invoice below
carries **no `due_date`** — that used to be required:

```sh
INV=$(curl -s -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d "{\"customer_id\":\"$CUST\",\"currency\":\"MYR\",
       \"lines\":[{\"description\":\"Consulting\",\"quantity\":1,\"unit_cents\":250000}]}" \
  http://localhost:8787/v1/invoices \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['invoice_id'])")

curl -s -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"channel":"email"}' http://localhost:8787/v1/invoices/$INV/reminder
```

The response carries `contact_id` and `contact_match: "role"`, the `wrangler dev`
log prints a `[reminder:console]` line naming Ravi's address, and the audit row
records which contact it was:

```sh
npx wrangler d1 execute companyos-db --local --command \
  "SELECT to_address, contact_id FROM deliveries ORDER BY created_at DESC LIMIT 1;"
```

Drop Ravi's `billing` role (`PATCH .../contacts/<id>` with
`{"roles":["other"]}`) and repeat — it falls back to Aina and reports
`contact_match: "primary"`.

### The graceful-failure path

Make a customer with **no contacts and no email or phone**, invoice it, and send
a reminder. You get **422 `no_recipient`** *and* a `customer.no_contact` event.

Both, deliberately. PRD-003's criterion says dispatch "fails gracefully with a
`customer.no_contact` event rather than throwing", but swallowing the error would
make the endpoint answer 202 for a send that never happened — and the
CollectionsAgent already treats `DeliveryError` as a graceful non-send (it logs,
keeps tracking, and does not record a contact that never occurred). Graceful here
means no unhandled exception plus an observable event, not a false 2xx.

The event is written by the queue consumer, so on the default config wait for the
batch:

```sh
sleep 6
npx wrangler d1 execute companyos-db --local --command \
  "SELECT event_type, payload FROM events_log WHERE event_type = 'customer.no_contact';"
```

Or use `wrangler.free.jsonc` for inline dispatch — but if you do, pass
`--config wrangler.free.jsonc` to **every** command including the migration; the
two configs do not share a local database (see the warning above).

### Payment terms drive the due date (this touches finance)

`payment_terms_days` is the PRD-003 field that changes invoice creation, which is
why S8 is the CRM session that had to keep the finance suites green (conflict C7
in [`prd/SESSION-PLAN.md`](prd/SESSION-PLAN.md)).

```sh
curl -s -X PATCH -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"payment_terms_days":45}' http://localhost:8787/v1/customers/$CUST
```

Create another invoice with no `due_date` → due is today + 45. Then set
**Settings → Company profile → Default payment terms (days)**, clear the
customer's own field, and create a third → it uses the tenant number. An explicit
`due_date` still wins over both.

One distinction worth exercising, because collapsing it would be a silent 30-day
extension for a cash-on-delivery customer: `payment_terms_days = null` means
"use the tenant default", `0` means "due on issue". The console shows the former
as *Tenant default*, and a blank field sends `null` rather than `0`.

### Health and the credit warning

The customer list has a **Health** column; the detail page has an **Account
health** panel showing the contributing reasons, not just a band. PRD-003 is
explicit that the reasons are the product — *"2 invoices 60+ days overdue"* is
actionable, a number is not.

To force `at_risk`:

```sh
npx wrangler d1 execute companyos-db --local --command \
  "UPDATE invoices SET status = 'overdue', due_date = '2026-01-01' WHERE customer_id = '$CUST';"
```

Reload → **At risk**, with both invoice ids named in the reasons and linked
through to the invoices. A brand-new customer reads **Good** with an explicit
*"nothing to assess"* reason rather than a misleading score.

Set a credit limit below outstanding AR, then open **New invoice** for that
customer: an amber warning appears and the submit button **stays enabled**. That
is the requirement — warn only, never block — and no server-side path rejects
anything on credit grounds either.

**Health is a signal and nothing acts on it.** `at_risk` does not pause
collections or any outbound path; that was PRD-003's blocking question and the
answer was signal-only for v1. Pausing belongs to PRD-002's guardrail layer
(`agents.enabled`, `agent_paused`), so if you are looking for a send to stop
because of health, it will not — by design.

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
