# CompanyOS — Production Deployment

*Last updated: 2026-08-02 · Deployment: **live** (Workers Free plan, queue-less mode)*

The single reference for how the production CompanyOS platform is deployed,
configured, and operated. Generic background lives elsewhere and is linked
where relevant — this file records **our** deployment.

---

## 1. Topology

| Component | Where | Name |
|---|---|---|
| Operator console (SPA) | Cloudflare Pages → **https://console.companyos.com.my** | project `companyos-console` |
| API (gateway + modules + agents) | Cloudflare Worker → **https://api.companyos.com.my** (custom domain) | worker `companyos-backend` |
| Database | Cloudflare D1 (SQLite) | `companyos-db` |
| Config/auth cache + sessions | Workers KV | `CONFIG_CACHE`, `SESSIONS` |
| Uploaded files (logos, receipts, signatures) | Cloudflare R2 | bucket `companyos-files`, binding `FILES` |
| Collections agent | Durable Object (SQLite-backed, one per tenant+customer) | `CollectionsAgent` |
| Event bus | **None (free plan)** — events dispatch inline via the direct bus | see [queue-send.md](queue-send.md) |
| Schedules | Cron Triggers | daily sweep `0 1 * * *` (UTC), Gmail sync `*/5 * * * *` |

Constraints that shape this layout:

- **One registrable domain for both hostnames.** The console authenticates
  with a `SameSite=Lax` HttpOnly session cookie, so `console.` and `api.`
  must share a registrable domain (`companyos.com.my`). Moving either to a
  different domain breaks login.
- **Free plan ⇒ no Cloudflare Queues.** The Worker detects the missing
  `EVENTS` binding and processes events inline. Trade-offs and mechanics:
  [queue-send.md](queue-send.md) §1–3. Upgrading later is config-only (§9).

## 2. Configuration files

- **`wrangler.free.jsonc`** — the config we deploy with (`npm run
  deploy:free`). Carries the real D1/KV IDs, cron triggers, and
  `ALLOWED_ORIGINS`. No `queues` block — that absence is what enables
  queue-less mode.
- **`wrangler.jsonc`** — identical plus the `queues` block and dev-placeholder
  secret vars; used by local dev (`npm run dev`) and the test suite, and
  becomes the deploy config if we ever move to the paid plan (strip the
  placeholder secret vars first — see §3). **Keep the two in sync** when
  changing vars, bindings, or crons, except for those two deliberate
  differences.
- **`ui/`** — the console; the API origin is baked in at build time via
  `VITE_API_BASE_URL` (login page hides the base-URL field entirely).

### Creating the R2 bucket

The `FILES` binding in both wrangler configs points at a bucket that has to
exist before the first deploy that includes it:

```sh
npx wrangler r2 bucket create companyos-files
```

R2 has a free tier, so this works on the free plan. The bucket needs **no
public access setting**: public reads of a `quote_logo` are served by the
Worker's own `GET /files/:id` route, which checks the purpose policy first.
Leave the bucket private — a bucket-level public URL would bypass that check.

## 3. Secrets

Set with `npx wrangler secret put <NAME>` from the repo root (they attach to
the worker name `companyos-backend`). Secrets and plain-text `vars` share one
binding namespace, so `wrangler.free.jsonc` deliberately defines **no** vars
with these names — a deployed var with the same name makes `secret put` fail
with *"Binding name 'X' already in use"* (code 10053), and a later deploy
would revert the secret to the plain-text placeholder. The dev placeholders
live only in `wrangler.jsonc`, which serves local dev and tests.

Order matters on a fresh setup: `npm run deploy:free` first, then set the
secrets immediately — until `SESSION_SECRET` is set, logins fail, and the
admin/webhook routes fail closed with 503.

| Secret | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | **yes** | HMAC-signs session cookies. Placeholder value = forgeable logins. |
| `PLATFORM_ADMIN_SECRET` | **yes** | Bearer token guarding `/admin/tenants` company provisioning. Placeholder value = anyone can mint companies. |
| `WEBHOOK_MASTER_SECRET` | if using JIRA/GitHub/Bitbucket webhook ingestion | Derives per-source webhook signing secrets. |
| `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) | optional | LLM-driven collections decisions; without it the agent uses the deterministic fallback. |
| `RESEND_API_KEY` | optional | Real email delivery (invoice reminders, user invites, password resets). Without it, sends log to the console. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | optional | WhatsApp delivery. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_TOKEN_ENCRYPTION_KEY` | optional | Gmail send-as + inbox sync ([modules/google.md](modules/google.md)). Encryption key: `head -c 32 /dev/urandom \| base64`. Register `https://api.companyos.com.my/oauth/google/callback` on the OAuth client. |

Generate random secrets with `openssl rand -base64 32`. Rotating
`SESSION_SECRET` signs everyone out (they just log back in); rotating
`PLATFORM_ADMIN_SECRET` only changes the bearer token for future
provisioning calls. Tenant API keys are unaffected by either.

### Transactional email (invites / password resets)

System email (user invites, password resets) sends whenever a transport is
configured — it does **not** require the per-tenant `delivery_config` opt-in,
which only gates customer-facing mail (reminders). For production:

- `RESEND_API_KEY` — the platform Resend key (domain `companyos.com.my`
  must be verified in Resend).
- `SYSTEM_FROM_ADDRESS` var — the sender identity for system mail; set
  `CompanyOS <hello@companyos.com.my>` (must be on the verified domain;
  make sure the mailbox can receive replies). System mail **always** uses
  this, never a tenant's `delivery_config.from_address` — tenant domains
  aren't verified in our Resend account, so using one would bounce.
- `CONSOLE_BASE_URL` var — the public console origin used to build the
  links inside invite/reset emails. `wrangler.free.jsonc` (the deploy
  config) sets `https://console.companyos.com.my`; `wrangler.jsonc` keeps
  `http://localhost:5173` for local dev and the test suite, so these two
  intentionally differ.

Transport routing when a tenant's email `delivery_config` names a
`google_account_id`:

- **Password resets always use the platform transport** (Resend → console),
  never the tenant's mailbox — account recovery must not depend on a
  tenant's OAuth grant still being valid.
- **Invites and customer mail** do route through that connected Gmail
  mailbox, which always sends as the authenticated Google account (so
  `SYSTEM_FROM_ADDRESS` does not apply on that path).

So when diagnosing "nothing arrived via Resend", check `delivery_config`
first: an invite may have gone out via Gmail perfectly well.

The `/v1/auth/password/*` and `/v1/auth/invite/*` endpoints carry KV-based
best-effort rate limits (KV is eventually consistent). Back them with a
Cloudflare WAF rate-limiting rule on `/v1/auth/*` as the hard production
backstop.

## 4. Deploying the API (Worker)

```sh
npm install
npm test && npm run typecheck        # keep the suite green before deploying
npm run db:migrate:remote:free       # apply any new D1 migrations (idempotent)
npm run deploy:free
```

`db:migrate:remote:free` tracks applied migrations server-side, so it's safe
to run every deploy. Never edit an applied migration — add the next
`NNNN_*.sql` instead.

That safety is about *re-running*, not about the migration's own contents. If the
pending migration changes existing rows, adds a constraint, or alters
customer-facing behaviour, stop and work through [§8.1](#81-when-a-deploy-is-not-routine)
first — it wants a backup and a deploy order, neither of which this section
provides.

## 5. Deploying the console (Pages)

```sh
cd ui && npm install
npm run build:prod          # bakes in VITE_API_BASE_URL=https://api.companyos.com.my
npx wrangler pages deploy dist --project-name companyos-console
```

**Use `build:prod`, never a bare `npm run build`, for anything you deploy.**
`VITE_API_BASE_URL` pins the API origin into the bundle: operators never see an
"API base URL" field, and stale localStorage overrides are ignored. Built
without it, the bundle silently falls back to `http://localhost:8787` — every
visitor's own machine — and the only symptom is `ERR_CONNECTION_REFUSED` behind
a generic "could not reach the server". Worse, anyone who previously typed an
origin into the dev-only base-URL field keeps working via their localStorage
override, so the deploy looks fine to whoever tests it and fails for every new
person. The public auth pages now detect this and say so outright, but the fix
is to rebuild with the var set.

Sanity check after deploying: load the login page in a private window. If an
"API base URL" field is visible, the var did not bake in. The
custom domain `console.companyos.com.my` is attached to the Pages project in
the Cloudflare dashboard (Pages → companyos-console → Custom domains); it
survives redeploys.

## 6. CORS

The Worker only answers credentialed browser requests from origins listed in
`ALLOWED_ORIGINS` (`wrangler.free.jsonc` vars):

```jsonc
"ALLOWED_ORIGINS": "https://console.companyos.com.my,http://localhost:5173,http://127.0.0.1:5173"
```

If the console's origin ever changes, update this and `npm run deploy:free`
— symptoms of a mismatch are browser-console errors like *"blocked by CORS
policy: No 'Access-Control-Allow-Origin' header"* while `curl` works fine
(CORS is browser-only enforcement). Quick check that CORS is right:

```sh
curl -si -X OPTIONS https://api.companyos.com.my/v1/auth/login \
  -H "Origin: https://console.companyos.com.my" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" | grep -i access-control
```

## 7. Onboarding a company

One call per company, authenticated with `PLATFORM_ADMIN_SECRET`:

```sh
curl -X POST https://api.companyos.com.my/admin/tenants \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Inc","slug":"acme","admin_email":"admin@acme.com","admin_password":"<strong-password>"}'
```

- The response contains the company's **API key exactly once** (only its
  SHA-256 hash is stored) — save it in a password manager immediately.
- The admin signs in at `https://console.companyos.com.my` with **workspace
  slug + email + password** and lands in the first-run onboarding wizard:
  company profile + base currency (required), teams/employees (skippable).
- Email is unique per company, workspaces are fully isolated, and the same
  address can hold accounts at several companies. Details:
  [architecture/multi-company-identity.md](architecture/multi-company-identity.md).
- `GET /admin/tenants` (same bearer) lists existing companies.

Currently provisioned: `dvsb` — Dapat Vista (M) Sdn Bhd.

## 8. Routine updates

1. Pull/merge the latest `main`.
2. `npm test && npm run typecheck` at the root (and `cd ui && npm test` for
   console changes).
3. Worker changed → §4. Console changed → §5. Either is safe to redeploy
   alone; deploys are atomic and take seconds.
4. If a change touched `wrangler.jsonc`, mirror it into
   `wrangler.free.jsonc` (minus the `queues` block) before deploying.

**Step 3 assumes the two halves are independent.** They usually are, and most
migrations are additive nullable columns. Three kinds of change break that
assumption, and §8.1 is the checklist for them.

### 8.1 When a deploy is not routine

Run through these four questions before any deploy. A "yes" to any of them means
the release has an order, a backup, or an operator heads-up attached to it — none
of which the four steps above provide.

**1. Does the migration change existing rows, or add a constraint?**

D1 has **no down-migrations**. An additive nullable column is trivially safe to
roll forward past; a statement that rewrites values or adds a `UNIQUE` index is
not, because the old code may violate the new constraint and the old values are
gone.

Take an export first — it is the only rollback for the data half:

```sh
npx wrangler d1 export companyos-db --remote --config wrangler.free.jsonc \
  --output ./backup-pre-NNNN-$(date +%Y%m%d).sql
```

Also: **test the migration against a populated database, not just a fresh one.**
`applyD1Migrations` in the test suite runs against an empty database, which is
the exact blind spot that let the original `0022_roles_drop_check` bug through —
it passed CI and could not be applied to production at all. The cheap version is
to apply it locally over a seeded database before it goes near `--remote`.

**2. Does the new code read something the old schema does not have?**

Then the order is **migrate → Worker → console**, and it is not interchangeable:

- Worker before the migration → 500s on the missing table or column.
- Console before the Worker → the SPA reads fields the old API does not return.
  A missing object is usually survivable; a missing **array** is not, because
  `thing.items.length` throws on `undefined` and takes the whole page with it.

**3. How long is the gap between the migration and the Worker deploy?**

Between those two steps the **old** Worker is running against the **new** schema.
That is fine for added columns and fatal for added constraints: old code that
wrote a now-unique value keeps trying, and users see raw
`UNIQUE constraint failed` errors. Run the two back to back. Minutes is fine;
migrating in the morning and deploying after lunch is not.

**4. Does the change alter behaviour on a customer-facing path?**

Recipient resolution, message content, due dates, anything that reaches a
customer without an operator pressing a button. These need a *look at the data*
before the deploy, not just a passing test suite — the tests prove the new
behaviour is correct, not that it is what the tenant expects to happen tomorrow.

#### Worked example — `0027_crm_depth.sql` (PRD-003, S8)

All four applied, which is why it is recorded here rather than described in the
abstract:

| Question | For `0027` |
|---|---|
| Changes rows / adds a constraint? | **Yes.** Backfills `contact_roles`, rewrites `contacts.is_primary` from those roles, then adds a partial unique index (one primary per customer). Verified against a populated database carrying all three pre-0027 shapes — two primaries, none, and one that is not the earliest contact — and it resolves them rather than failing. |
| New code needs new schema? | **Yes.** The console reads `contact.roles`, an array, so a console-first deploy white-screens the customer page. |
| Migration → deploy gap? | **Matters.** The pre-S8 `createContact` set `is_primary` directly with no demote step, so during the gap a second primary contact is a `UNIQUE constraint failed`. |
| Customer-facing behaviour change? | **Yes, and this was the one to check first.** Reminders previously went to `customers.email`; they now resolve billing contact → primary → any contact, falling back to the customer record only when there are no contacts. So the next reminder can reach a different person than it did the day before. |

The pre-deploy look for that last one:

```sh
npx wrangler d1 execute companyos-db --remote --config wrangler.free.jsonc --command "
SELECT c.name AS customer, ct.name AS contact, ct.email, ct.is_primary
FROM customers c LEFT JOIN contacts ct
  ON ct.tenant_id = c.tenant_id AND ct.customer_id = c.customer_id
ORDER BY c.name;"
```

An empty right-hand side means nothing changes for that tenant. Rows with stale
or personal addresses mean the roles want fixing — which is the feature, but it
should be a decision rather than a discovery.

Post-deploy, the constraint is the thing to confirm landed cleanly:

```sh
npx wrangler d1 execute companyos-db --remote --config wrangler.free.jsonc --command "
SELECT customer_id, COUNT(*) AS primaries FROM contacts
WHERE is_primary = 1 GROUP BY tenant_id, customer_id HAVING primaries > 1;"
# zero rows expected
```

And in the console, the **Roles** column on a customer's contacts table is the
canary for a version mismatch: if it renders, both halves are on the new build.

## 9. Upgrade path: free → paid (real Queues)

When on the Workers Paid plan, no code changes are needed:

```sh
npx wrangler queues create companyos-events
npx wrangler queues create companyos-events-dlq
# copy the real D1/KV IDs from wrangler.free.jsonc into wrangler.jsonc
npm run db:migrate:remote   # same DB, now addressed via wrangler.jsonc
npm run deploy              # EVENTS binding present ⇒ async queue dispatch
```

This buys retries + a dead-letter queue for event processing
([queue-send.md](queue-send.md) §5).

## 10. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Browser: *"blocked by CORS policy"*, curl works | Console origin missing from `ALLOWED_ORIGINS` → §6. |
| Login `403 Forbidden`, but the app's only auth errors are 401 | Cloudflare zone security in front of the Worker (Bot Fight Mode, WAF rule, or an Access app on `api.`). Check dashboard → Security → Events for the rule that fired; can also be transient edge propagation right after a deploy — retry first. |
| Login `401 invalid_credentials` for a real user | Wrong workspace slug (unknown workspace intentionally reports as bad credentials to prevent tenant enumeration). |
| "Could not reach …" naming a URL with a path | Stale/typo'd base URL — production builds pin it (§5), so rebuild with the right `VITE_API_BASE_URL`. |
| `/admin/tenants` returns 503 | `PLATFORM_ADMIN_SECRET` unset on the Worker (the route fails closed). |
| `wrangler secret put` fails: *"Binding name 'X' already in use"* (code 10053) | The worker has a deployed plain-text var with that name (e.g. from an old config that carried placeholder secrets in `vars`). Remove it from the deploy config, `npm run deploy:free`, then re-run `secret put` right away. |
| Google connect flow errors at Google | Placeholder `GOOGLE_*` secrets, or the callback URL isn't registered on the OAuth client → §3. |
| Reminder emails/WhatsApp not sending | No provider secret and/or no enabled per-tenant `delivery_config` row — without them delivery logs to console only. |

## 11. Security checklist

- [ ] `SESSION_SECRET` set to a real secret (not the repo placeholder)
- [ ] `PLATFORM_ADMIN_SECRET` set to a real secret — verify the placeholder
      is rejected: the curl in §7 with the dev value must return 401
- [ ] Tenant API keys and admin passwords stored in a password manager;
      never in shell history or chat (rotate any that were)
- [ ] `ALLOWED_ORIGINS` lists only origins we control
- [ ] Google OAuth client (if used) restricted to the production callback URL
