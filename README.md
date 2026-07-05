# CompanyOS

An AI-agent-first operating system for running a company. Every business process is exposed through one normalized, machine-readable API so AI agents — not humans clicking through dashboards — are the default consumers.

**Phase 0** (this repo) is the data spine and agent orchestration layer: the Cloudflare-side "brain" that normalizes unmodified OSS modules (ERPNext for finance, Twenty for sales, Plane for build, Libredesk for support) running on a VPS into a single internal API, an event bus, and per-tenant agent runtimes. See [docs/architecture/phase-0.md](docs/architecture/phase-0.md) for the full design.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| HTTP framework | [Hono](https://hono.dev) |
| Database | D1 (serverless **SQLite** — source of truth for tenant config + normalized data) |
| Cache | KV (read-through cache only; eventually consistent, never source of truth) |
| Agent runtime | Durable Objects (`CollectionsAgent`, one per tenant+customer, with `alarm()` re-checks) |
| Event bus | Cloudflare Queues (+ dead-letter queue) |
| Validation | Zod — versioned event schemas (`invoice.overdue.v1`) |
| Testing | Vitest + `@cloudflare/vitest-pool-workers` (tests run in the real Workers runtime) |

## Layout

```
migrations/          D1 schema (tenants, credentials, customers, invoices, events_log)
src/
  index.ts           Worker entry: Hono app + queue consumer
  schemas/           Event envelope + versioned payload schemas + registry
  gateway/
    routes/          /v1/invoices, /v1/customers, /v1/webhooks/erpnext
    middleware/      API-key auth + tenant/credential resolution (D1 truth, KV cache)
    adapters/        ModuleAdapter contract + ERPNext (Frappe) implementation
  agents/            CollectionsAgent Durable Object
  queue/             Event-bus consumer: validate → log → route to agent DO
docs/architecture/   Design docs
```

## The vertical slice

The proof-of-architecture loop, runnable entirely in mock mode (no live ERPNext needed):

1. ERPNext webhook fires → `POST /v1/webhooks/erpnext`
2. Gateway normalizes the payload into an `invoice.overdue` event → Cloudflare Queue
3. Queue consumer validates the envelope, appends it to `events_log` (D1), routes it to the tenant's `CollectionsAgent` Durable Object
4. Agent updates per-customer state (risk score, escalation stage) and sends a templated reminder via the gateway adapter
5. `payment.received` closes the loop and resets agent state

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
curl -X POST http://localhost:8787/v1/webhooks/erpnext \
  -H "Authorization: Bearer <printed_api_key>" \
  -H "Content-Type: application/json" \
  -d '{"doctype":"Sales Invoice","name":"inv_789","customer":"cust_456","status":"Overdue","outstanding_amount":4500,"currency":"MYR","due_date":"2026-06-26"}'
```

Pass `--tenant-id`, `--name`, or `--api-key` to `npm run seed:local` to customize the seeded tenant.

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
4. Set `MOCK_MODE` to `"false"` in `wrangler.jsonc` once tenants have real ERPNext credentials in `tenant_credentials`.

## Roadmap

- **Phase 1** — make the Collections Agent smart (LLM-driven risk assessment and message composition), real email/WhatsApp delivery.
- **Phase 2/3** — Sales (Twenty), People (ERPNext HR), Support (Libredesk), Build (Plane) adapters plugging into the same `ModuleAdapter` contract; more event types on the same bus.
