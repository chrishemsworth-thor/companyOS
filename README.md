# CompanyOS

An AI-agent-first operating system for running a company. Every business
process is exposed through one normalized, machine-readable API so AI agents —
not humans clicking through dashboards — are the default consumers.

All four business domains are **native modules on Cloudflare**: Finance
(double-entry ledger, invoices, payments), CRM (customers, deals,
activities), Support (tickets), and Build (projects, issues). One Worker, one
D1 database, one event bus, one API key per tenant — no external OSS apps, no
VPS. See [docs/architecture/phase-1-native.md](docs/architecture/phase-1-native.md)
for the full design ([phase-0.md](docs/architecture/phase-0.md) records the
earlier OSS-wrapping approach it replaced).

Per-module references: [Finance](docs/modules/finance.md) ·
[CRM](docs/modules/crm.md) · [Support](docs/modules/support.md) ·
[Build](docs/modules/build.md). What's next:
[Phase 2 plan](docs/architecture/phase-2-plan.md).

## Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| HTTP framework | [Hono](https://hono.dev) |
| Database | D1 (serverless **SQLite** — all module data incl. the append-only ledger) |
| Cache | KV (tenant-auth read-through cache only) |
| Agent runtime | Durable Objects (`CollectionsAgent`, one per tenant+customer, with `alarm()` re-checks) |
| Event bus | Cloudflare Queues (+ dead-letter queue) |
| Scheduling | Cron trigger (daily overdue sweep) |
| Validation | Zod — versioned event schemas (`invoice.overdue.v2`) |
| Testing | Vitest + `@cloudflare/vitest-pool-workers` (tests run in the real Workers runtime) |

## Layout

```
migrations/          D1 schema: tenants + finance ledger + CRM + support + build
src/
  index.ts           Worker entry: Hono app + queue consumer + cron handler
  schemas/           Event envelope + versioned payload schemas + registry
  modules/
    finance/         Ledger (balanced, append-only), invoices, payments, overdue sweep
    crm/             Customers, pipeline/deals, activities
    support/         Tickets + explicit state machine
    build/           Projects, issues
  delivery/          DeliveryProvider port (email/WhatsApp; console impl for dev)
  gateway/
    routes/          /v1/invoices, payments, ledger, customers, deals, activities, tickets, projects, issues
    middleware/      API-key auth + tenant resolution (D1 truth, KV cache)
  agents/            CollectionsAgent Durable Object
  queue/             Event-bus consumer: validate → log → route to agent DO
docs/architecture/   Design docs
ui/                  Operator console (read-only dashboard + list/detail views), see ui/README.md
```

## The vertical slice

The proof loop, fully native (runnable locally with no external services):

1. `POST /v1/invoices` issues an invoice — invoice rows + a balanced
   Dr AR / Cr Revenue journal entry commit in one atomic batch, `invoice.created` hits the bus
2. `POST /v1/invoices/:id/send` marks it sent
3. The daily cron sweep finds it past due → status `overdue` → emits `invoice.overdue` (v2, integer cents)
4. Queue consumer validates the envelope, appends it to `events_log` (D1), routes it to the tenant's `CollectionsAgent` Durable Object
5. Agent updates per-customer state (risk score, escalation stage), sends a reminder through the `DeliveryProvider` port, and logs a `reminder_sent` activity in the CRM
6. `POST /v1/payments` settles the invoice (Dr Cash / Cr AR) and `payment.received` resets the agent

## Development

```sh
npm install
npm test                  # full suite in the Workers runtime
npm run typecheck
npm run db:migrate:local  # apply D1 migrations locally
npm run dev               # wrangler dev
```

In a second terminal, seed a local tenant and try the vertical slice:

```sh
npm run seed:local
```

This prints a tenant id, a plaintext API key (only shown here — the DB stores just its SHA-256 hash), and a ready-to-run curl command, e.g.:

```sh
curl -X POST http://localhost:8787/v1/invoices \
  -H "Authorization: Bearer <printed_api_key>" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_456","currency":"MYR","due_date":"2026-06-26","lines":[{"description":"Consulting","quantity":1,"unit_cents":450000}]}'
```

Pass `--tenant-id`, `--name`, or `--api-key` to `npm run seed:local` to customize the seeded tenant.

To populate that tenant with a realistic dataset across every module (a few
customers, invoices in different lifecycle states including one flipped to
`overdue`, deals, tickets, a project with issues) instead of building it up
by hand:

```sh
npm run seed:sample -- --api-key <printed_api_key>
```

Handy for poking around the [operator console](ui/README.md) without
inventing data yourself.

## Deploying

1. Create the resources and paste the returned IDs into `wrangler.jsonc` (they ship as placeholders):
   ```sh
   npx wrangler d1 create companyos-db
   npx wrangler kv namespace create CONFIG_CACHE
   npx wrangler queues create companyos-events
   npx wrangler queues create companyos-events-dlq
   ```
2. `npm run db:migrate:remote`
3. `npm run deploy`

### Real delivery (email / WhatsApp)

Reminders go through the `DeliveryProvider` port (`src/delivery/`). Without
configuration they log to the console; real sends require **both**:

1. Provider secrets on the Worker:
   ```sh
   npx wrangler secret put RESEND_API_KEY       # email via Resend
   npx wrangler secret put TWILIO_ACCOUNT_SID   # WhatsApp via Twilio
   npx wrangler secret put TWILIO_AUTH_TOKEN
   ```
2. A per-tenant opt-in row in `delivery_config` with the sender identity
   (`from_address` is an email address for `email`, an E.164 number for
   `whatsapp`) and `enabled = 1`.

Recipient addresses come from the customer record (`email`/`phone`); if the
requested channel has no address the other channel is used, and every send
attempt is logged in the `deliveries` table.

### Smart collections (LLM)

The `CollectionsAgent` assesses risk and composes reminders with an LLM
behind a provider-agnostic port (`src/llm/`). Configure whichever provider
you use:

```sh
npx wrangler secret put ANTHROPIC_API_KEY   # Claude (default model claude-opus-4-8)
# or
npx wrangler secret put OPENAI_API_KEY      # OpenAI (default model gpt-5)
```

Optional vars: `LLM_PROVIDER` (`anthropic` | `openai`) pins a provider when
both keys exist; `LLM_MODEL` overrides the default model id. With no key
configured — or on any API/validation failure — the agent falls back to the
deterministic Phase 1 heuristic and template, so collections never silently
stops. Every decision (LLM or fallback) is audited into `events_log` as a
`collections.decision.v1` event; escalation emits `customer.risk_flagged.v1`.

## Roadmap

- **Phase 2** — make the agents smart (LLM-driven risk assessment and message
  composition, ✅ Workstream 2) and wire real delivery providers
  (email/WhatsApp) behind the `DeliveryProvider` port (✅ Workstream 1);
  transactional outbox if new event types need it.
  Full brief: [docs/architecture/phase-2-plan.md](docs/architecture/phase-2-plan.md).
- **Phase 3** — People/HR module on the same pattern; cross-module Insights
  (the payoff of one database: support tickets × overdue invoices × open
  deals are plain SQL joins).
