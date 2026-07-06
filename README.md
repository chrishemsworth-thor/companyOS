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

Try the slice locally (after seeding a tenant row in the local D1 — see
`test/finance-lifecycle.test.ts` for the shape):

```sh
curl -X POST http://localhost:8787/v1/invoices \
  -H "Authorization: Bearer <tenant_api_key>" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"cust_456","currency":"MYR","due_date":"2026-06-26","lines":[{"description":"Consulting","quantity":1,"unit_cents":450000}]}'
```

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

## Roadmap

- **Phase 2** — make the agents smart (LLM-driven risk assessment and message
  composition) and wire real delivery providers (email/WhatsApp) behind the
  `DeliveryProvider` port; transactional outbox if new event types need it.
- **Phase 3** — People/HR module on the same pattern; cross-module Insights
  (the payoff of one database: support tickets × overdue invoices × open
  deals are plain SQL joins).
