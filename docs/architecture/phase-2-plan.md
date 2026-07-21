# CompanyOS — Phase 2 Plan: Smart Agents & Real Delivery

A standalone brief for the session that implements Phase 2. It assumes no
prior context beyond this repo.

## Where the repo stands (end of Phase 1)

All four business domains run as **native modules on Cloudflare** — no VPS, no
external OSS apps. One Worker (Hono), one D1 database (SQLite; money as
integer cents; composite `(tenant_id, id)` PKs), one event bus (Queues +
Zod-versioned schemas in `src/schemas/events/`), Durable Object agents, KV
auth cache, a daily cron sweep. Read in this order before writing code:

1. `docs/architecture/phase-1-native.md` — topology, event flow, ledger invariants
2. `docs/modules/{finance,crm,support,build}.md` — per-module reference
3. `src/modules/finance/service.ts` — the write-then-emit pattern every module follows
4. `src/agents/collections.ts` + `src/queue/consumer.ts` — the agent runtime and routing map
5. `test/finance-lifecycle.test.ts` — the test pattern (real Workers runtime via `@cloudflare/vitest-pool-workers`, per-file isolated D1)

Phase 1's collections behavior is deliberately dumb: a fixed risk heuristic
(`days_overdue * 5 + reminders * 10`), a templated reminder string, and a
log-and-ack `ConsoleDelivery`. Phase 2 makes the loop real: **actual message
delivery** and **LLM-driven agent intelligence**.

## Workstream 1 — Real delivery providers

**Goal:** reminders reach customers over email and WhatsApp instead of the
console.

The port already exists: `src/delivery/types.ts` defines
`DeliveryProvider.send(req: ReminderRequest) → {delivery_ref}`;
`src/delivery/console.ts` is the log-and-ack default and `getDeliveryProvider()`
is the selection point (called from `src/agents/collections.ts` and
`src/gateway/routes/invoices.ts`).

- **Email:** implement `src/delivery/resend.ts` (Resend — plain `fetch` to
  `https://api.resend.com/emails`, works natively on Workers). **WhatsApp:**
  `src/delivery/twilio.ts` (Twilio Messages API).
- **Selection:** `getDeliveryProvider(env, channel)` returns the real provider
  when its secret is configured, else `ConsoleDelivery`. Secrets via
  `wrangler secret put RESEND_API_KEY` / `TWILIO_*`; add optional fields to
  `src/env.ts`. Tests never configure secrets → keep hitting console.
- **Recipient data:** `ReminderRequest` carries only `customer_id` — the
  provider needs an address. Resolve `email`/`phone` from the `customers`
  table at the call site (both already exist as columns) and extend
  `ReminderRequest` with `to`. A customer without an address for the requested
  channel → fall back to the other channel or 422.
- **Migration 0007 (`delivery_config`):** per-tenant sender identity —
  `(tenant_id, channel)` PK, `from_address`, `enabled`. Tenant-level opt-in
  keeps accidental live sends impossible until configured.
- **Delivery log:** append a `deliveries` table row per send
  (`delivery_ref`, channel, provider, status) — collections needs to know
  what was actually sent, and Phase 3 insights will want it.

**Acceptance:** with secrets + config present, `POST /v1/invoices/:id/reminder`
sends real email; without them, behavior is unchanged. Tests: mock `fetch`
(Vitest `vi.stubGlobal`) to assert request shape; console fallback covered.

## Workstream 2 — Smart CollectionsAgent (LLM)

**Goal:** replace the fixed heuristic and template in
`src/agents/collections.ts` with Claude-driven risk assessment and message
composition.

- **API access:** call the Claude API from the DO. Use `@anthropic-ai/sdk`
  (fetch-based, Workers-compatible) with model **`claude-opus-4-8`** and
  adaptive thinking (`thinking: {type: "adaptive"}`); do **not** set
  `temperature`/`top_p` (removed on this model). API key via
  `wrangler secret put ANTHROPIC_API_KEY`; add to `Env`. In tests, stub the
  client (inject via a factory like `getDeliveryProvider`) — never hit the
  live API from the suite.
- **Context assembly:** before composing, gather what one database makes
  cheap: the customer row, open/overdue invoices, payment history
  (`payments` × `payment_applications`), recent `activities` (including prior
  `reminder_sent` rows), and open deals — a customer with a big open deal
  gets a gentler nudge.
- **Structured output:** ask for a decision object via
  `output_config: {format: {type: "json_schema", ...}}` —
  `{risk_score: 0-100, action: "remind"|"escalate"|"wait", channel, message}`.
  Validate with Zod before acting; on invalid output or API failure, fall back
  to the Phase 1 template so collections never silently stops.
- **Escalation ladder:** use the existing `escalation_stage`
  (`none → reminded → escalated`): first contact friendly, repeat contact
  firmer, `escalated` emits **`customer.risk_flagged.v1`**
  (`customer_id, risk_score, open_invoices, total_due_cents`) — new schema +
  registry entry (this event was named in the phase-0 design; Phase 2 makes it
  real). Route it nowhere for now (audit log) or to a future notification.
- **alarm() becomes real:** today the daily re-check only logs. Make it
  re-run the assessment (skip if `last_contact` < 24h ago) so nagging
  frequency is a decision, not a side effect of the sweep.
- **Rate limiting / safety:** never send more than one reminder per customer
  per 24h regardless of how many overdue events arrive (the sweep re-emits
  daily by design); cap message length; log the full decision object into
  `events_log` via a `collections.decision.v1` event for auditability.

**Acceptance:** with a stubbed LLM returning a canned decision, the agent
stores the risk score, sends the composed message through the delivery port,
writes the activity row, and escalation emits `customer.risk_flagged`. The
fallback path (LLM error → template) has its own test.

## Workstream 3 — Transactional outbox (only if needed)

Phase 1 deliberately deferred this: there is a small window where a D1 write
commits but `EVENTS.send` fails. Today the overdue sweep re-emits
`invoice.overdue`, covering the one event an agent depends on. **Trigger for
building it:** Workstream 2 makes `customer.risk_flagged` (or any new event)
load-bearing for a consumer that can't tolerate loss. Design when needed:
`outbox` table written in the same batch as the domain rows; drain in the
`scheduled` handler + after each request via `ctx.waitUntil`; delete on
successful send; consumer dedupe already exists (`INSERT OR IGNORE` by
`event_id`).

## Workstream 4 — Opportunistic foundations (small, do alongside)

- **Idempotency keys:** honor an `Idempotency-Key` header on `POST /v1/invoices`
  and `POST /v1/payments` (table keyed `(tenant_id, key)` storing the response) —
  agents retry, and double-recording a payment is the worst outcome in the system.
- **Cursor pagination:** list endpoints currently return everything; add
  `?limit=&cursor=` (ULID ids are time-sortable — cursor on the id) before
  datasets grow.
- **Phase 3 pointer (do not build now):** People/HR module on the same
  pattern; cross-module Insights (SQL joins over tickets × invoices × deals).

## Workstream 5 — Apollo CRM integration (contact enrichment + lead import)

**Goal:** turn thin CRM records into rich ones and let the pipeline fill
itself. Apollo.io is the source of truth for B2B people/company data;
CompanyOS's `customers` (and the org/contacts tables from the Quotes work)
stay the system of record. Apollo *enriches* and *seeds* — it never owns a row.

Apollo's REST API is plain HTTPS + an `X-Api-Key` header, so it works natively
on Workers with `fetch` — the same shape as the delivery providers. Follow the
port pattern so the suite never touches the live API.

- **Provider port:** `src/enrichment/types.ts` defines
  `EnrichmentProvider.enrichPerson(req) → PersonMatch` and
  `.searchPeople(query) → PersonMatch[]`; `src/enrichment/apollo.ts` is the
  real implementation (People Enrichment `POST /v1/people/match`, Organization
  Enrichment `POST /v1/organizations/enrich`, prospecting via
  `POST /v1/mixed_people/search`). `src/enrichment/none.ts` is a no-op default,
  and `getEnrichmentProvider(env)` returns Apollo only when `APOLLO_API_KEY` is
  configured — else the no-op, so tests and un-provisioned tenants stay inert.
  Secret via `wrangler secret put APOLLO_API_KEY`; add the optional field to
  `src/env.ts`.
- **Data model (next migration, `0015_apollo_enrichment.sql`):**
  - `apollo_links` — maps a local row to its Apollo entity so re-enrichment is
    idempotent and we never double-import: `(tenant_id, entity_type, entity_id)`
    PK where `entity_type ∈ ('customer','org','contact')`, plus
    `apollo_id`, `matched_at`, `confidence`. `UNIQUE (tenant_id, apollo_id,
    entity_type)` stops two local rows claiming the same Apollo person.
  - `enrichment_log` — one row per API call (`entity_id`, `provider`,
    `outcome ∈ matched|no_match|error`, `cost_credits?`, `created_at`) so
    Apollo credit spend is auditable and Phase 3 insights can see it.
  - Enriched fields (title, company, LinkedIn URL, seniority, location) land on
    the existing contact/org columns where they exist; anything without a home
    goes in a small `contact_enrichment` side table keyed by `contact_id`
    rather than widening the core tables.
- **Enrichment flow:** `POST /v1/customers/:id/enrich` resolves the customer,
  calls the port, writes the enriched fields + an `apollo_links` row + an
  `enrichment_log` row, and logs an `activity` (`kind: note`,
  `"Enriched from Apollo"`) so the touch history shows it. Re-enriching an
  already-linked row updates in place (no duplicate link). Missing
  `APOLLO_API_KEY` → 422 `enrichment_unconfigured`; Apollo no-match → 200 with
  `{matched: false}`, no partial writes.
- **Lead import / prospecting:** `POST /v1/leads/import` takes an Apollo search
  query (title, seniority, industry, headcount), calls `searchPeople`, and for
  each hit **upserts** a `customer` (dedupe on email, then on `apollo_id` via
  `apollo_links`) and drops a `deal` into the first pipeline stage (`Lead`) so
  imported prospects enter the funnel exactly like manual ones. Cap batch size
  (e.g. 25/call) and honor `Idempotency-Key` (Workstream 4) — re-running an
  import must not fan out duplicate deals.
- **Events:** `customer.enriched.v1`
  (`customer_id, apollo_id, fields_updated[], confidence`) and
  `lead.imported.v1` (`customer_id, deal_id, apollo_id, source: "apollo"`) —
  new Zod schemas in `src/schemas/events/` + `registry.ts` entries. Audit-log
  only for now; a future SalesAgent (Phase 3) claims them via `AGENT_ROUTES`.
- **Safety / limits:** Apollo bills per credit — never enrich the same row
  twice within 30 days (check `apollo_links.matched_at`) unless `?force=true`;
  cap prospecting result count; never send PII to Apollo beyond what the match
  endpoint needs (email/name/domain). All outbound calls go through the port so
  a tenant with no key can't spend credits by accident.

**Acceptance:** with `APOLLO_API_KEY` set and `fetch` stubbed
(`vi.stubGlobal`) to return a canned Apollo match, `POST /v1/customers/:id/enrich`
writes the enriched fields, an `apollo_links` row, an `enrichment_log` row, an
activity, and emits `customer.enriched`; a second enrich of the same customer
updates in place with no duplicate link. `POST /v1/leads/import` upserts
customers + `Lead`-stage deals and is idempotent under a repeated
`Idempotency-Key`. Without the key, both endpoints stay inert (422 / no-op
provider) and the rest of the suite is unaffected.

## Recommended order

1. Workstream 1 (delivery) — smallest, unblocks real-world value, and
   Workstream 2 composes messages into it.
2. Workstream 2 (smart agent) — the headline feature.
3. Workstream 4 idempotency keys — before any agent is given retry authority
   (Workstream 5's lead import depends on them).
4. Workstream 5 (Apollo CRM) — fills the pipeline; reuses the delivery port
   pattern and the idempotency work above.
5. Workstream 3 — only when its trigger fires.

Commit per workstream; keep `npm test` + `npm run typecheck` green at every
commit (61-test baseline at the time of writing).

## How to start (fresh session checklist)

```sh
git fetch origin && git checkout <phase-2 branch from latest main or the phase-1 branch>
npm install
npm test && npm run typecheck     # green baseline before touching anything
```

Then read the five items under "Where the repo stands", pick Workstream 1,
and follow the existing patterns: schema change → migration file (next
sequential number; never edit applied ones), service module under
`src/modules/` or `src/delivery/`, Zod event schema + registry entry, thin
Hono route, test file mirroring `test/finance-service.test.ts`.
