# CompanyOS — Built Features Inventory

*Compiled 2026-07-24 from the actual code on `main`. Everything listed here is
shipped and tested unless explicitly marked otherwise. Intended for
cross-referencing against the business plan.*

CompanyOS is an **agent-first business operating system**: every business
process is exposed through one normalized `/v1/*` API, designed for AI agents
as the primary consumers, with a human operator console as the secondary path.
It runs as **one Cloudflare Worker + one D1 (SQLite) database** per deployment
— native modules, no wrapped third-party apps, no VPS.

---

## 1. Platform foundation

- **Multi-tenant from day one** — every table is keyed by `tenant_id`; each
  company is fully isolated on one shared platform. New companies are
  provisioned at runtime through an internal admin API
  (`POST /admin/tenants`, guarded by `PLATFORM_ADMIN_SECRET`) that creates
  the tenant, its first admin user, and an API key in one call.
- **Multi-company identity** — email is unique *per company*, so the same
  person can hold accounts at several companies; operators log in with
  **workspace slug + email + password**.
- **Dual auth model**:
  - **Agents/integrations**: per-tenant API key (`Authorization: Bearer …`),
    SHA-256-hashed at rest, D1 as source of truth with a KV read-through
    cache. (A design doc for scoped, rotatable, admin-managed API keys is
    written but not yet implemented.)
  - **Humans**: server-side sessions — PBKDF2 password hashing, HMAC-signed
    HttpOnly cookie, CSRF token on every mutating request. The tenant API
    key never reaches the browser.
- **Roles** — `admin`, `operator`, `finance`, `support`, `readonly`, with a
  `requireRole()` gate (People writes are the first business use).
- **User lifecycle** — admin-managed users with email invites
  (accept-invite flow sets the password via token), resend-invite,
  forgot/reset password, and change password. All powered by the
  transactional email layer.
- **Event bus** — services emit versioned, Zod-validated domain events
  (**37 registered event types**) through Cloudflare Queues (+ dead-letter
  queue); the consumer validates against a schema registry, appends every
  event to an append-only `events_log` (with actor attribution), and routes
  selected types to agents. A queue-less inline fallback
  (`wrangler.free.jsonc`) runs the whole system on Cloudflare's free plan.
- **API hygiene** — idempotency keys (claim-before-run) on money-touching
  writes, cursor pagination, rate limiting, security headers (nosniff,
  X-Frame-Options, Referrer-Policy, HSTS), credentialed CORS, and a
  July 2026 security audit with fixes (reflected-XSS fix on the OAuth
  callback, etc.).
- **Departments as a lens** — a canonical taxonomy of **11 departments**
  (7 live: Finance, Sales, Customer Experience, Technology, Data/AI,
  Management, People; 4 planned: Product, R&D, Legal, Operations), each
  mapping to capability modules, allowed roles, and console routes. Served
  to agents at `GET /v1/meta/departments` and mirrored in the UI
  (parity-tested).

## 2. Finance module (strongest — the reference department)

- **Double-entry general ledger** — balanced journal entries enforced before
  an atomic write (unbalanced input never persists); **append-only** enforced
  by SQL triggers; corrections are reversal entries
  (`POST /v1/ledger/entries/:id/reverse`). System chart of accounts seeded
  per tenant (Cash, AR, AP, Equity, Revenue, Expenses). All money in integer
  cents.
- **Invoices** — line items, full lifecycle (draft → sent → overdue → paid);
  creating an invoice posts a balanced Dr AR / Cr Revenue entry in the same
  atomic batch and emits `invoice.created`.
- **Payments** — many-to-many settlement (one payment across several
  invoices), Dr Cash / Cr AR posting, `payment.received` events.
- **Daily overdue sweep** — a cron trigger flips past-due invoices to
  `overdue` and emits `invoice.overdue`, which drives the collections agent.
- **Manual journal entries** — anything outside invoicing/payments is
  expressible as a `manual` entry via the API or console.

## 3. Collections agent (the working autonomous agent)

- `CollectionsAgent` — a Durable Object, **one instance per
  tenant + customer**, woken by `invoice.overdue` / `payment.received` events
  and a daily `alarm()` re-check.
- **LLM-driven decisions** — assembles cross-module context (open invoices,
  payment history, CRM activities, open deals) and asks an LLM for a
  structured decision: risk score, action (remind / escalate / wait),
  channel, and composed message. Zod-validated; on any failure or with no
  key configured it **falls back to a deterministic heuristic + template**,
  so collections never silently stops.
- **Provider-agnostic LLM port** — Anthropic (default `claude-opus-4-8`) or
  OpenAI, selected by configured keys / `LLM_PROVIDER`.
- **Auditable** — every decision (LLM or fallback) is logged to `events_log`
  as `collections.decision.v1`; escalation emits `customer.risk_flagged.v1`;
  every reminder sent is written into the CRM activity log as
  `reminder_sent`, next to human notes and calls.
- **Guardrails** — 24-hour per-customer contact cooldown; payment received
  resets the agent's escalation state.

## 4. Sales / CRM module

- **Customers** — root entity shared with finance and support; create/edit,
  per-customer contacts (create/edit), activity timeline, live collections
  agent snapshot, and **native payment history** (a plain SQL join with the
  finance module — the payoff of one shared database).
- **Leads** — pre-customer prospects with create/update, **one-call
  conversion** to customer + contact + deal (with lineage), and a pluggable
  **enrichment port** (`POST /v1/leads/:id/enrich`; ships with a no-op
  provider, Apollo-style providers slot in behind `ENRICHMENT_PROVIDER`).
- **Deal pipeline** — per-tenant stages (default: Lead → Qualified →
  Proposal → Won → Lost, customizable), stage moves emit
  `deal.stage_changed`, and won/lost stages settle the deal and emit
  `deal.won` / `deal.lost`.
- **Activities** — append-only touch log (note / call / email / meeting /
  reminder_sent) shared by humans and agents.
- *(Designed, not built: a `SalesAgent` to prospect into and work the
  pipeline — see `docs/architecture/sales-module-design.md`.)*

## 5. Quotes (quote-to-cash)

- Quotes with line items, **per-line discounts and header-level tax**,
  lifecycle (draft → sent → accepted / rejected / expired), and one-call
  **conversion to an invoice**.
- **Rendered quote documents** — server-rendered HTML (`GET
  /v1/quotes/:id/document`) with per-tenant **branding settings** (company
  profile, number/date formats, template config).
- **Automatic expiry** — a cron sweep expires lapsed quotes and emits
  `quote.expired`.
- Company profile + base currency settings (default `MYR`) live under
  `/v1/settings`.

## 6. Support module

- Tickets with priorities and an **explicit state machine**
  (open → pending → resolved → closed; illegal moves are 409s that list the
  legal transitions; customers replying re-opens resolved tickets).
- Append-only threaded messages (author: customer / agent / system).
- `ticket.resolved` and `ticket.status_changed` events for future agents.
- *(No support agent yet — a SupportAgent on the CollectionsAgent pattern is
  the intended consumer.)*

## 7. Build module (engineering)

- Projects and issues (status board: todo / in_progress / done / cancelled,
  priorities, assignee), with settled-state re-open rules and
  `issue.completed` events.
- **Webhook ingestion from JIRA, GitHub, and Bitbucket** — signature-verified
  inbound webhooks (`POST /webhooks/:provider/:source_id`) mirror external
  issues into Build (idempotent upserts via an `external_refs` anchor, so
  redeliveries and out-of-order events converge) and log code activity
  (`code.push`, `code.pr_opened`, `code.pr_merged`) on the event bus. Teams
  keep their tracker; agents see engineering work alongside everything else.
  Sources are self-service via `/v1/webhook-sources`.
  *(Inbound only — no write-back to the provider yet.)*

## 8. People / HR module

- Employee directory (job title, department, employment type, status,
  start/end dates, location), **teams** with leads, and **reporting lines**
  (manager hierarchy with cycle detection; self-management blocked).
- Employees are HR records first, optionally linked to a console login.
- Offboarding is soft (`status = inactive`); no hard deletes.
- *(Leave/approval workflows and payroll are out of scope so far.)*

## 9. Outbound communications

- **DeliveryProvider port** with real providers behind per-tenant opt-in:
  **Resend** (email), **Twilio** (WhatsApp), console logger for dev/tests.
  Channel fallback (email ↔ WhatsApp) when the requested channel has no
  address; every send attempt is audited in a `deliveries` table.
- **Google / Gmail integration** — full OAuth 2.0 flow (single-use state
  nonce, AES-256-GCM-encrypted refresh tokens at rest, on-demand access
  tokens cached in KV):
  - **Shared inboxes** (e.g. `support@company.com`, tenant-wide) and
    **send-as-user** personal mailboxes.
  - Outbound send (standalone and as an invoice-reminder delivery channel).
  - **Inbound read** — a 5-minute cron polls Gmail history and emits
    `email.received` events onto the bus (events only; no backfill).
- **Transactional email foundation** — system emails (user invites, password
  resets) with shared templates, sent regardless of tenant delivery opt-in.

## 10. Insights (cross-module BI)

Read-only SQL rollups over the one shared database — dashboard summary KPIs,
**AR aging buckets**, revenue by month, pipeline by stage, and ticket
insights. No write path by design.

## 11. Operator console (`ui/`)

React + Vite + TanStack Query single-page app over the same `/v1` API:

- **Auth** — login (workspace + email + password), accept-invite,
  forgot/reset password; session cookie + CSRF handled by the API client.
- **Dashboard** — KPI tiles (overdue invoices, open deals, tickets, issues by
  status), AR-aging, multi-currency aware.
- **Full CRUD surfaces** for every module: invoices (create/send/remind/
  record payment), ledger (browse accounts + balances, post + reverse journal
  entries), customers & contacts, leads (incl. convert), deals (create/stage
  move with optimistic updates), quotes (create/send/accept/reject/convert +
  branded document view), tickets (create/reply/status), projects & issues,
  employees & teams.
- **Agent activity** — a tenant-wide feed of collections-agent decisions,
  risk flags, and invoice events; per-customer agent snapshot cards;
  invoice-scoped event timelines.
- **Departments** page mirroring the 11-department org-chart lens
  (live vs planned).
- **Users admin**, **Settings** (company profile, quote branding), and a
  skippable **first-run onboarding wizard** (company profile → teams →
  employees) for new admins.
- Light/dark theme, ~18 domain modals, idempotency keys on invoice/payment
  creation so retries can't double-charge.

## 12. Operations & quality

- **Testing** — ~40 backend Vitest suites running in the **real Workers
  runtime** (`@cloudflare/vitest-pool-workers`) covering every module, auth,
  multi-company, idempotency, pagination, webhooks per provider, Google
  OAuth/sync/delivery, the collections agent, and LLM fallback; plus a UI
  test suite (client, theme, department parity, key components).
- **Seeding** — `seed:local` (tenant + API key + first operator login) and
  `seed:sample` (realistic data across every module, including an overdue
  invoice to wake the agent).
- **Deployment** — production deploy documented (custom domain
  `api.companyos.com.my`, secrets runbook); paid config with Queues and a
  free-plan config without; 19 D1 migrations; cron triggers for the overdue
  sweep, quote expiry, and Gmail sync.
- **Security** — July 2026 security audit doc with applied fixes; security
  headers; encrypted OAuth tokens; hashed API keys and passwords.

---

## Built vs. planned, at a glance

| Capability | Status |
|---|---|
| Finance: ledger, invoices, payments, overdue sweep | ✅ Built |
| Autonomous collections agent (LLM + fallback) | ✅ Built |
| CRM: customers, contacts, leads, deals, activities | ✅ Built |
| Quotes → invoice (quote-to-cash) with branded documents | ✅ Built |
| Support tickets + state machine | ✅ Built (no agent yet) |
| Build: projects/issues + JIRA/GitHub/Bitbucket inbound sync | ✅ Built (inbound only) |
| People: directory, teams, reporting lines | ✅ Built (no leave/payroll) |
| Cross-module insights / dashboard | ✅ Built |
| Multi-tenant platform + multi-company identity + roles | ✅ Built |
| Real delivery: Resend email, Twilio WhatsApp, Gmail (in+out) | ✅ Built |
| Transactional email (invites, password reset) | ✅ Built |
| Operator console covering all modules + onboarding | ✅ Built |
| Sales agent (prospecting / pipeline working) | 📝 Designed only |
| Scoped, rotatable API keys | 📝 Designed only |
| Support/Build agents, Marketing, Ops/Legal/IT, leave/HR workflows | ⬜ Not started |
| Lead enrichment providers (Apollo etc.) | ⬜ Port built, no real provider |
