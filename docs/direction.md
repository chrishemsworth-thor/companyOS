# CompanyOS: Direction & Department Coverage

*Last updated: 2026-07-14*

This document captures **where CompanyOS is headed** and maps the product, as it
stands today, onto the **core departments of a company** — so we can see at a glance
where coverage is strong and where the whitespace is.

---

## 1. What CompanyOS is now

CompanyOS is an **agent-first business operating system**. Every business process is
exposed through one normalized, machine-readable API, and the *default consumer of that
API is an AI agent*, not a human clicking a dashboard. Humans operate the system as a
secondary path, through the operator console (`ui/`).

The technical thesis is deliberately narrow: **one Cloudflare Worker, one D1 (SQLite)
database, native modules — no wrapped third-party apps.** This is a change of direction
from where the project started.

- **Phase 0** (`docs/architecture/phase-0.md`, *superseded*) proposed wrapping four
  open-source apps — ERPNext (finance), Twenty (CRM), Libredesk (support), Plane
  (projects) — on a VPS, behind a `ModuleAdapter` translation layer. Each app was
  effectively "a database with business rules," and the cost was adapters, webhooks, and
  hosting for every one of them.
- **Phase 1** (`docs/architecture/phase-1-native.md`, *current*) replaced that with
  greenfield **native modules**. A new business capability now costs "just a D1 schema +
  a service + routes + events" — no adapter, no extra app to host, no sync layer.
  Cross-module features become plain SQL joins because everything lives in one database.
- **Phase 2** (`docs/architecture/phase-2-plan.md`) is the near-term roadmap: smarter LLM
  agents, real outbound delivery, idempotency, cursor pagination, and a People/HR module.

Two platform layers have since shipped on top of this spine:
[multi-company identity](./architecture/multi-company-identity.md) (many isolated
companies on one platform, workspace-scoped login, runtime provisioning) and
[departments as a lens](./architecture/department-lens.md) (the full org chart —
11 departments, `live` vs `planned` — mapped over the capability modules).

The result is one platform, one API, one database, one auth model — and business logic
that agents can drive end-to-end. The worked example today is the **CollectionsAgent**,
which chases overdue invoices autonomously from detection to reminder.

## 2. Architectural pillars

Kept short here — the architecture docs are the source of truth.

- **One API** — REST under `/v1/*`, built on Hono. Each module is a sub-app mounted in
  `src/index.ts`. Requests validated with Zod at the boundary.
- **One database** — Cloudflare D1 (serverless SQLite), bound as `env.DB`. Every table is
  tenant-scoped (`tenant_id` first in the composite primary key); IDs are prefixed ULIDs.
- **One auth model** — a per-tenant API key (`Authorization: Bearer …`) for agents/
  integrations, plus human session cookies for the console. Resolved once in shared
  middleware.
- **Events → queue → agents** — services emit versioned domain events to a Cloudflare
  Queue; the consumer validates them against a registry, appends to an append-only
  `events_log`, and routes selected event types to agents.
- **Agents are Durable Objects** — stateful, one instance per tenant+subject, waking on an
  `alarm()` to act. `CollectionsAgent` (`src/agents/collections.ts`) is the reference
  implementation and, today, the **only** autonomous agent.

See [`architecture/phase-1-native.md`](./architecture/phase-1-native.md) for the full
treatment.

## 3. Departments vs. modules — coverage matrix

The left column is the set of core departments most companies have. The rest shows what
CompanyOS provides for each today. "Module" names map to `src/modules/*` and the
`source_module` tag stamped on every event.

| Department | CompanyOS module today | Autonomous agent? | Maturity / gap |
|---|---|---|---|
| **Finance / Accounting** | `finance` — double-entry ledger, invoices, payments, daily `overdue-sweep` | ✅ `CollectionsAgent` | **Strongest.** Append-only journal enforced in SQL, cron, and a working agent. |
| **Sales / Revenue** | `crm` (`source_module: sales`) — customers, deal pipeline, activity log | ❌ (a `SalesAgent` is reserved, not built) | **Primary gap.** Records & pipeline exist; nothing prospects into it or works it. See [sales design](./architecture/sales-module-design.md). |
| **Customer Support** | `support` — tickets + explicit state machine (open→pending→resolved→closed) | ❌ | Solid records + lifecycle; no agent triaging or resolving yet. |
| **Engineering / Product** | `build` — projects and issues (board) | ❌ | Basic board. |
| **Cross-functional / BI** | `insights` — read-only cross-module SQL aggregates for the dashboard | n/a (read-model) | Reporting only; no write path, by design. |
| **Marketing** | — | — | Not present. Natural neighbor to Sales. |
| **People / HR** | `people` — employee directory, teams, reporting lines ([docs](./modules/people.md)) | ❌ | Directory + org structure shipped; leave/HR workflows are the remaining gap. |
| **Operations / Legal / IT** | — | — | Whitespace. |

Note: `sourceModuleSchema` in `src/schemas/envelope.ts` whitelisted both `"sales"` and
`"people"` ahead of time as anticipated extension points; People has since cashed that
reservation in with the `people` module.

Since this matrix was first written, the [department lens](./architecture/department-lens.md)
now models the **full org chart** explicitly: 11 departments, each marked `live` (backed by a
shipped module) or `planned` (part of the model, shown disabled). The whitespace below —
Marketing/Product/R&D, Operations/Legal — is now *named* as `planned` departments
rather than being invisible, so the build order stays legible even before the modules exist.
`GET /v1/meta/departments` serves that taxonomy to agents.

## 4. Where we're strong vs. thin

- **Strong — Finance.** It's the reference department: normalized data model, an event
  stream, a cron sweep, and the only department with an autonomous agent acting on its
  events. Everything else is measured against it.
- **Highest-leverage next step — Sales.** The pipeline data model already exists, but it's
  inert: no prospecting fills it, no sequences work it, and no agent advances it. Because
  the spine (customers, deals, activities) is already there, this is the cheapest place to
  add real autonomy and the most valuable. This is the subject of the companion
  [Sales Module design doc](./architecture/sales-module-design.md).
- **Thin — Support & Build.** Good records and (for support) lifecycle, but no agents.
  Obvious future homes for triage/resolution and issue-grooming agents respectively.
- **Thin — People/HR.** The `people` module ships the directory, teams, and manager
  hierarchy, but no leave/approval workflows and no agent yet.
- **Whitespace — Marketing, Operations/Legal/IT.** Not yet modeled.

## 5. Guiding principle for new modules

The matrix above is really measuring each department against one yardstick. A department
is "fully in CompanyOS" when it has all three of:

1. **A normalized data model** — tenant-scoped tables in the shared D1 database.
2. **An event stream** — versioned domain events on the bus, audit-logged in `events_log`.
3. **At least one agent that acts on it** — a Durable Object that turns those events into
   autonomous work.

Most departments today have (1) and (2). Only Finance has (3). Closing that third gap,
department by department — starting with Sales — is the direction of travel.
