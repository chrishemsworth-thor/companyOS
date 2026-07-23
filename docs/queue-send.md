# Event Sending — Queues vs Queue-less (Free-Plan) Mode

*Last updated: 2026-07-22 · Status: **implemented***

How CompanyOS events get from "emitted" to "processed", and how to deploy the
whole platform on the **Workers Free plan** — Cloudflare Queues is the one
paid-only piece of the stack, and the Worker runs without it.

Source: `src/queue/direct.ts`, `src/queue/consumer.ts` (`processEvent`),
`src/index.ts`, `src/agents/collections.ts`, `wrangler.free.jsonc`.
Tests: `test/direct-event-bus.test.ts`.

---

## 1. The two send paths

Every module emits events with `env.EVENTS.send(envelope)` (or via
`emitEvent()` in `src/queue/producer.ts`). What happens next depends on which
wrangler config the Worker was deployed with:

| | **Queue mode** (`wrangler.jsonc`, paid plan) | **Direct mode** (`wrangler.free.jsonc`, free plan) |
|---|---|---|
| `EVENTS` binding | Cloudflare Queues producer | absent — substituted at runtime by the direct bus |
| Processing | async, in the queue consumer | inline, inside the emitting request/cron/DO call |
| Retries | 3 attempts, then dead-letter queue | none — failures are logged and dropped |
| Backpressure | queue buffers spikes | none (irrelevant at small scale) |

Both paths run the **same code**: `processEvent()` in `src/queue/consumer.ts`
(validate the envelope against the schema registry → append to the
`events_log` audit table → route `invoice.overdue` / `payment.received` to the
tenant's `CollectionsAgent` Durable Object). The queue consumer and the direct
bus are two callers of one pipeline, so behavior stays identical.

## 2. How the fallback activates

`ensureEventBus(env)` (`src/queue/direct.ts`) is called at every place the
runtime hands us an `env`:

- the `fetch` handler and the `scheduled` (cron) handler in `src/index.ts`
- the `CollectionsAgent` constructor (`src/agents/collections.ts`) — the DO
  gets its own env and emits its own audit events (`collections.decision`,
  `customer.risk_flagged`)

If `env.EVENTS` exists (queue mode) the env passes through untouched. If not,
a shallow copy is returned whose `EVENTS` implements the `Queue` producer
interface (`send` / `sendBatch`) by calling `processEvent()` directly. No
call site changes, no config flag — **the presence or absence of the queue
binding is the switch.**

## 3. What direct mode gives up, and why it's fine at small scale

- **No retries / DLQ.** If processing an event fails (e.g. a transient D1
  error), that one event's side effects are lost. The business write that
  emitted it (the invoice, the payment) is already committed, so nothing
  corrupts — at worst a collections nudge doesn't fire that day. The daily
  cron sweep re-emits `invoice.overdue` for every invoice still unpaid, so
  collections **self-heals on the next cycle**. Failures are logged as
  `[direct-bus] event processing failed`.
- **Inline latency.** The emitting request pays for event processing: one D1
  insert for audit-only events, plus the agent hop for `payment.received`
  (quick state update) — negligible. The heavyweight path (`invoice.overdue`
  → LLM → delivery) runs from the cron sweep, not a user request.
- **Send errors don't fail requests.** The direct bus swallows processing
  errors, matching queue-mode semantics where `send()` succeeds and failures
  surface later in the consumer.

For 2–3 companies this is a good trade; free-tier limits elsewhere (100k
requests/day, 5M D1 row reads/day, 100k KV reads/day) are far above SME usage.

## 4. Free-plan deploy runbook

Everything except Queues has a free tier: Workers, D1, KV, cron triggers, and
SQLite-backed Durable Objects (`new_sqlite_classes` — which is what
`CollectionsAgent` uses).

### 4.1 One-time platform setup

```sh
npx wrangler login

# Create resources (NO queues) and paste the printed IDs into wrangler.free.jsonc
npx wrangler d1 create companyos-db
npx wrangler kv namespace create CONFIG_CACHE
npx wrangler kv namespace create SESSIONS

# Apply the schema to the remote D1
npm run db:migrate:remote:free

# Production secrets (generate each with: openssl rand -base64 32)
npx wrangler secret put SESSION_SECRET
npx wrangler secret put PLATFORM_ADMIN_SECRET
npx wrangler secret put WEBHOOK_MASTER_SECRET   # only if using webhook ingestion

# Optional: LLM-driven collections + real delivery
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN

# Optional: Google email (send-as + Gmail inbox sync) — docs/modules/google.md.
# Needs a Google Cloud OAuth web client with
# https://<worker-domain>/oauth/google/callback as an authorized redirect URI.
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_TOKEN_ENCRYPTION_KEY   # head -c 32 /dev/urandom | base64

# Deploy the Worker (API)
npm run deploy:free
```

> Secrets attach to the Worker by name (`companyos`), which both configs
> share — no need to re-put them if you later switch configs.

> The Google vars ship as dev placeholders in the wrangler configs; without
> real secrets the connect flow simply fails at Google's consent screen, and
> everything else runs normally. If the Worker sits behind a custom domain
> whose origin differs from what it sees, also set
> `GOOGLE_OAUTH_REDIRECT_URI`.

Both cron triggers — the daily overdue/quote sweep and the 5-minute Gmail
inbox sync — are plain Cron Triggers, available on the free plan (288
invocations/day for the sync is far below free-tier request limits; with no
Google accounts connected it's a no-op).

### 4.2 Operator console (UI)

Bake the API origin into the build (`VITE_API_BASE_URL`) — the login page
then hides the "API base URL" field entirely, so operators only ever see
workspace/email/password:

```sh
cd ui && npm install
VITE_API_BASE_URL=https://api.yourdomain.com npm run build
npx wrangler pages deploy dist --project-name companyos-console
```

Login uses a `SameSite=Lax` HttpOnly cookie, so in production serve the
console and the API under **one registrable domain** (e.g.
`app.yourdomain.com` for Pages, `api.yourdomain.com` as a custom domain on
the Worker). Then set `ALLOWED_ORIGINS` in `wrangler.free.jsonc` `vars` to the
console origin and redeploy (`npm run deploy:free`).

### 4.3 Onboard each company

One call per company, guarded by `PLATFORM_ADMIN_SECRET`:

```sh
curl -X POST https://api.yourdomain.com/admin/tenants \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Inc","slug":"acme","admin_email":"admin@acme.com","admin_password":"a-strong-password"}'
```

The response includes the company's API key **exactly once** (only its hash is
stored) — save it. Operators log into the console with **workspace slug +
email + password**. Full details:
[architecture/multi-company-identity.md](architecture/multi-company-identity.md).

On the admin's first console login, the **onboarding wizard** takes over:
company profile (legal name, base currency — the default for new invoices,
deals, and quotes) is required; teams and employees can be added there or
skipped and managed later. Repeat provisioning + onboarding once per company.

## 5. Upgrading to real Queues later

When you move to the Workers Paid plan, no code changes are needed:

```sh
npx wrangler queues create companyos-events
npx wrangler queues create companyos-events-dlq
npm run deploy          # the standard config, wrangler.jsonc
```

Copy the D1/KV IDs from `wrangler.free.jsonc` into `wrangler.jsonc` first —
the two files must point at the same resources. Deploying with the `EVENTS`
binding present flips the Worker back to async queue dispatch automatically.

## 6. Keeping the configs in sync

`wrangler.free.jsonc` duplicates `wrangler.jsonc` minus the `queues` block
(wrangler has no config inheritance). When you change bindings, vars, crons,
or DO migrations in one file, mirror it in the other. Local dev and the test
suite always use `wrangler.jsonc` (with Queues, simulated locally — free) so
tests exercise queue mode by default; `test/direct-event-bus.test.ts` covers
direct mode explicitly.
