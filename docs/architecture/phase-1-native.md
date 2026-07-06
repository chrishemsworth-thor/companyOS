# CompanyOS — Phase 1: Native Modules on Cloudflare

Supersedes [phase-0.md](phase-0.md), which wrapped four unmodified OSS apps
(ERPNext, Twenty, Libredesk, Plane) on a VPS behind a `ModuleAdapter`
translation layer. Phase 1 replaces all of them with native modules on the
Cloudflare stack. There is no VPS, no webhook translation, and no per-tenant
external credentials.

## Why greenfield

CompanyOS is agent-first: AI agents are the default API consumers, humans are
secondary. The OSS apps were 90% human UI wrapped around tables and state
machines, and the gateway already normalized everything into its own schema —
so they were effectively databases with business rules, purchased at the cost
of four adapters, four webhook dialects, per-tenant instance hosting, version
drift, and AGPL containment. What a native module costs in this stack is a D1
schema, a service file, gateway routes, and event types — patterns proven by
the Phase 0 spine, which is kept unchanged.

Consequences:
- **One platform, one API, unified auth.** Modules are namespaces inside a
  single Worker (`/v1/invoices`, `/v1/deals`, `/v1/tickets`, `/v1/issues`)
  sharing one D1 database, one event bus, one API key per tenant. No
  per-module subdomains. Cross-module features are SQL joins, not
  integrations.
- **One consistency domain.** Every mutation and its ledger posting commit in
  a single atomic `env.DB.batch(...)`.
- **The only external boundary left is outbound delivery** (email/WhatsApp),
  behind the `DeliveryProvider` port in `src/delivery/` (`ConsoleDelivery`
  logs-and-acks until a real provider is wired).

## Deployment topology

```
┌─────────────────────────────────────────────────┐
│                   CLOUDFLARE                     │
│                                                  │
│  Workers          → API gateway (Hono, /v1/*)    │
│  D1               → All module data + ledger     │
│  Queues           → Event bus (+ DLQ)            │
│  Durable Objects  → Agent runtimes               │
│  KV               → Tenant auth cache            │
│  Cron trigger     → Daily overdue sweep          │
└──────────────────────┬───────────────────────────┘
                       │ HTTPS (outbound only)
                       ▼
            Delivery providers (email/WhatsApp)
```

## Modules

| Module | source_module | Tables | Routes | Reference |
|---|---|---|---|---|
| Finance | `finance` | accounts, journal_entries, journal_lines, invoices, invoice_lines, payments, payment_applications | `/v1/invoices`, `/v1/payments`, `/v1/ledger/*` | [docs/modules/finance.md](../modules/finance.md) |
| CRM | `sales` | customers, pipeline_stages, deals, activities | `/v1/customers`, `/v1/deals`, `/v1/activities` | [docs/modules/crm.md](../modules/crm.md) |
| Support | `support` | tickets, ticket_messages | `/v1/tickets` | [docs/modules/support.md](../modules/support.md) |
| Build | `build` | projects, issues | `/v1/projects`, `/v1/issues` | [docs/modules/build.md](../modules/build.md) |

Phase 2 (smart agents, real delivery) is specified in
[phase-2-plan.md](phase-2-plan.md).

Each module follows the same shape: `src/modules/<domain>/service.ts` owns all
writes (validate → atomic D1 batch → emit events); `src/gateway/routes/*`
are thin Hono routes behind the shared `apiKeyAuth` middleware.

## The ledger

Double-entry, minimal by design (no tax, no FX — single currency per entry):

- **Signed integer cents**: journal lines are `amount_cents` (> 0 debit,
  < 0 credit); every entry's lines must sum to exactly 0, enforced in
  `src/modules/finance/ledger.ts` before an atomic batch insert.
- **Append-only**: `RAISE(ABORT)` triggers block UPDATE/DELETE on
  journal_entries/journal_lines. Corrections are reversal entries
  (`source_type='reversal'`, `reverses_entry_id`).
- **Posting rules**: invoice issued → Dr Accounts Receivable / Cr Revenue;
  payment received → Dr Cash / Cr Accounts Receivable. Everything else is a
  `manual` entry via `POST /v1/ledger/entries` (unbalanced → 422).
- **System chart** (seeded per tenant, idempotent): 1000 Cash, 1100 AR,
  2000 AP, 3000 Equity, 4000 Revenue, 5000 Expenses.

## Events

Envelope (`src/schemas/envelope.ts`) is unchanged from Phase 0; payloads are
Zod-validated against the versioned registry (`src/schemas/events/registry.ts`).
Money in payloads is integer cents as of the v2 finance events.

| Event | Version | Emitted by |
|---|---|---|
| invoice.created | v1 | createInvoice |
| invoice.sent | v1 | sendInvoice |
| invoice.overdue | v2 | daily overdue sweep |
| payment.received | v2 | recordPayment (full settle) |
| payment.partial | v1 | recordPayment (partial settle) |
| customer.created | v1 | createCustomer |
| deal.created / deal.stage_changed / deal.won / deal.lost | v1 | deal service |
| activity.logged | v1 | logActivity |
| ticket.created / ticket.message_added / ticket.status_changed / ticket.resolved | v1 | ticket service |
| project.created / issue.created / issue.status_changed / issue.completed | v1 | build service |

**Flow**: service write commits → `EVENTS.send(envelope)` → queue consumer
validates against the registry, appends to `events_log` (`INSERT OR IGNORE`
dedupes by event_id), and routes via a per-event-type map — today
`invoice.overdue` and `payment.received` go to the tenant+customer
`CollectionsAgent` DO; unclaimed events are audit-logged only. Future agents
claim event types by adding entries to `AGENT_ROUTES` in
`src/queue/consumer.ts`.

**Overdue detection is a cron, not a webhook**: the daily sweep
(`src/modules/finance/overdue-sweep.ts`) marks past-due `sent` invoices
`overdue` and re-emits `invoice.overdue` for everything still unpaid.
Re-emission is deliberate — it re-nudges the agent daily and is the safety
net for the deferred outbox (see below).

### Deferred: transactional outbox

There is a small window where a D1 write commits but the queue send fails
(worker eviction). Mitigations today: handlers `await` the send before
responding, and the sweep re-emits overdue events. A true outbox table
(write event + row in one batch, drain to queue) is deliberately deferred
until an event type appears whose loss the sweep can't cover.

## State machines

- **Tickets** (`src/modules/support/state-machine.ts`): explicit transition
  table — open → pending|resolved, pending → open|resolved, resolved →
  closed|open, closed terminal. Illegal moves → 409.
- **Issues**: free-form board moves, except done/cancelled re-open only to
  todo.
- **Deals**: stage-driven — landing on a stage flagged is_won/is_lost settles
  status and emits deal.won/deal.lost.

## Agents

`CollectionsAgent` (Durable Object per tenant+customer, `alarm()` re-checks)
is unchanged in role: risk scoring, reminders via the `DeliveryProvider`
port, state reset on payment. New in Phase 1: every reminder is also written
to the CRM `activities` log (`kind='reminder_sent'`), so collections history
is visible next to notes/calls without any integration.

## Testing

`@cloudflare/vitest-pool-workers` runs everything in the real Workers
runtime with per-file isolated D1 (migrations auto-applied from
`migrations/`). Key suites:

- `test/finance-ledger.test.ts` — ledger invariants: balance enforcement,
  batch atomicity, append-only triggers, reversals, a global
  sum-to-zero check over a mixed op sequence.
- `test/finance-lifecycle.test.ts` — the vertical slice: create → send →
  sweep → consumer → CollectionsAgent → payment resets state.
- `test/crm.test.ts`, `test/support.test.ts` (exhaustive transition matrix),
  `test/build.test.ts`, `test/gateway.test.ts`, `test/envelope.test.ts`.
