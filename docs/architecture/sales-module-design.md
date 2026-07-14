# Sales Module — Apollo-Inspired Design

*Last updated: 2026-07-14 · Status: design proposal (no code yet)*

This is a **design document**, not an implementation. It proposes how CompanyOS should
grow a real sales capability, using [Apollo.io](https://www.apollo.io/) as the reference
for what "full sales" looks like. It builds on the direction laid out in
[`../direction.md`](../direction.md), where Sales is identified as the primary gap and the
highest-leverage next step.

---

## 1. Why

CompanyOS already has a CRM module (`source_module: sales`) — customers, a per-tenant deal
pipeline, and an append-only activity log (see [`../modules/crm.md`](../modules/crm.md)).
But it is **inert**: it records deals that already exist and nothing *fills* or *works* the
pipeline. There is no prospecting, no enrichment, no outreach sequences, and — critically
for an agent-first system — **no SalesAgent**. The CRM doc itself already anticipates one:
its events are audit-logged only, and "a future SalesAgent claims them via `AGENT_ROUTES`."

Apollo.io shows the shape of the missing piece: it turns a contact list into worked
pipeline through search, enrichment, multi-step sequences, a dialer, and analytics — all in
one workspace. We want the CompanyOS-native, agent-first version of that.

## 2. Apollo.io, decomposed

Apollo's product pillars, mapped to what is realistic for an agent-first, single-Worker
system — and what is not.

| Apollo pillar | What it is | CompanyOS translation | In scope now? |
|---|---|---|---|
| **Contact / company database** | A third-party database of 210M+ contacts / 35M+ companies to search | We store *our own* leads/prospects. The giant external database is a data-provider integration, not something we host. | ❌ Later (external provider) |
| **Enrichment** | Fill in missing contact/company fields from external data | An **enrichment port** (interface + no-op default), mirroring our existing `llm/` and `delivery/` ports; real providers slot in later. | ✅ Port now, providers later |
| **Sequences / cadences** | Multi-step outreach (email / call / LinkedIn) with timed follow-ups | A `sequences` + `sequence_steps` + `sequence_enrollments` model; sends reuse the existing `delivery/` providers. | ✅ Core of this work |
| **Dialer / engagement tracking** | Click-to-call, call recording, activity capture | Model engagement as activity/engagement events — extends the existing CRM `activity.logged` pattern. Real telephony is out of scope. | ✅ Tracking; ❌ telephony |
| **Deal / pipeline management** | Opportunities moving through stages | **Already exists** in `crm` (deals, `pipeline_stages`). Reuse, don't rebuild. | ✅ Reuse existing |
| **Meeting booking** | Scheduling links, calendar sync | Later phase. | ❌ Later |
| **Analytics & reporting** | Open/reply rates, pipeline dashboards | Folds into the existing `insights` read-model. | ❌ Later (via `insights`) |
| **AI / workflow automation** | AI-assisted writing, routing, next-best-action | This is where the **SalesAgent** lives — the CompanyOS-native payoff. | ✅ Phase C |

*Sources: [apollo.io](https://www.apollo.io/),
[prospect & enrich](https://www.apollo.io/product/prospect-and-enrich),
[what is Apollo.io (Klenty)](https://www.klenty.com/blog/what-is-apollo-io/),
[Apollo.io review (lagrowthmachine)](https://lagrowthmachine.com/apollo-io-review/).*

The honest takeaway: Apollo's moat is its **proprietary contact data**. We deliberately do
**not** try to replicate that. CompanyOS's edge is the opposite end — the **agent that
works the pipeline autonomously** once data is in it. So we build the engagement engine and
the agent, and treat external data as a pluggable input.

## 3. Recommended approach — grow CRM into the full Sales surface

**Do not build a parallel module.** Extend the existing CRM/sales domain. Rationale, all
grounded in the current codebase:

- **The slot is already reserved.** `"sales"` is already in `sourceModuleSchema`
  (`src/schemas/envelope.ts:10`), so new sales entities emit events under the existing
  `source_module: 'sales'` with no schema change.
- **The agent is already anticipated.** [`../modules/crm.md`](../modules/crm.md) explicitly
  says a future `SalesAgent` will claim CRM events via `AGENT_ROUTES` in
  `src/queue/consumer.ts`. We're building the thing the docs already point at.
- **The spine already fits.** Customers → deals → activities is the natural backbone for
  leads → sequences → engagement → deal. A separate module would duplicate the pipeline and
  fracture the `sales` domain across two places.

Concretely: add new entities under the same `source_module: 'sales'`, keeping the code in
`src/modules/crm/`. (Renaming that directory `crm/ → sales/` is reasonable but should be a
separate, isolated, mechanical PR so it doesn't muddy the feature work.)

New entities:

- **`leads`** — pre-customer prospects (an entity CRM explicitly lists as out of scope
  today). A lead converts into a `customer` + `deal` when qualified.
- **`sequences`** + **`sequence_steps`** — a named cadence and its ordered, delayed steps.
- **`sequence_enrollments`** — a lead's position in a sequence (which step, when the next
  one is due, active/paused/finished).
- Richer **engagement** events layered on the existing `activities` log.

## 4. Proposed shape (for the future build)

A sketch only, following the module conventions already used across the repo. Each bullet
names the existing pattern to copy.

- **Migration — `migrations/0012_sales.sql`.** New tenant-scoped tables (`tenant_id` first
  in the composite PK, `REFERENCES tenants`), ULID prefixes `lead_`, `seq_`, `sqs_`
  (step), `enr_` (enrollment). Follows `migrations/0004_support.sql`.
- **Service — in `src/modules/crm/`.** Free async functions `(env, tenantId, input)` that
  validate → `env.DB.batch([...])` → emit via `makeEnvelope(...)`, throwing a module error
  class. Mirrors `src/modules/support/service.ts`.
- **Events — versioned Zod files in `src/schemas/events/`,** registered in
  `src/schemas/events/registry.ts` (the consumer dead-letters any unregistered type). Likely
  set: `lead.created`, `lead.enriched`, `lead.converted`, `sequence.created`,
  `sequence.enrolled`, `sequence.step_sent`, `sequence.completed`. No change to
  `envelope.ts` — `"sales"` is already valid.
- **Routes — `src/gateway/routes/leads.ts`, `sequences.ts`,** each a `Hono` sub-app with
  `zValidator` bodies and cursor pagination, mounted in `src/index.ts` under `/v1/leads`
  and `/v1/sequences`. Mirrors `src/gateway/routes/tickets.ts`.
- **Agent (the payoff) — `SalesAgent` Durable Object,** modeled on
  `src/agents/collections.ts`: one instance per tenant+enrollment, waking on `alarm()` to
  send the next due step through the `delivery/` port, log an engagement activity, and
  schedule the following step. Wired by adding the sequence events to `AGENT_ROUTES` in
  `src/queue/consumer.ts`.
- **Enrichment port — `src/enrichment/`,** an interface + `noop.ts` default, mirroring the
  structure of `src/llm/` and `src/delivery/` so real providers can be dropped in without
  touching callers.
- **UI — pages under `ui/src/pages/crm/`** (Leads, Sequences) using `@tanstack/react-query`
  + `useAuth().client`, a route in `ui/src/App.tsx`, a nav entry under the CRM/Sales group
  in `ui/src/components/Layout.tsx`, and response types in `ui/src/api/types.ts`. Mirrors
  the existing CRM pages.
- **Tests — `test/sales.test.ts`,** driving real HTTP through `worker.fetch(...)` in the
  Workers runtime, following `test/crm.test.ts` / `test/support.test.ts`.

## 5. Phasing

- **Phase A — Leads + enrichment port.** `leads` table, CRUD routes, lead→customer/deal
  conversion, and the `src/enrichment/` port with a no-op default. Pipeline can now be
  *filled*.
- **Phase B — Sequences + enrollments.** The cadence model and enrollment mechanics; sends
  go through the existing `delivery/` providers (`console`/`resend`/`twilio`) but are still
  driven manually or by a simple cron. Pipeline can now be *worked*.
- **Phase C — SalesAgent autonomy.** The Durable Object that advances enrollments on its own
  via `alarm()`. This is the moment Sales reaches parity with Finance on the "agent acts on
  it" yardstick from [`../direction.md`](../direction.md).
- **Phase D — Analytics + external data.** Sequence/engagement metrics into `insights`, and
  a first external data-provider integration behind the enrichment port.

**Explicitly out of scope for the foreseeable future:** replicating Apollo's proprietary
210M-contact database, LinkedIn automation, and real dialer/telephony. CompanyOS competes
on the autonomous agent that works the pipeline, not on owning the contact graph.
