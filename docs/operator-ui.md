# Operator UI — Scoping

CompanyOS is API-first by design (see README: "AI agents — not humans
clicking through dashboards — are the default consumers"). This document
scopes what it would take to build a **full human-facing operator UI** on
top of the existing `/v1/*` API — forms and views for a person to run the
business day-to-day without an agent or curl in the loop. It is a scoping
exercise, not a commitment; see the recommendation at the end.

## Status

The §8 recommendation's first slice is built and has since grown a write
side: dashboard + list/detail views across all four modules, plus create
and transition forms for invoices (create/send/reminder/record payment),
ledger journal entries, customers (create/edit), deals (create/stage
move), activities, tickets (create/reply/status), projects, and issues
(create/status) — all against the existing `/v1/*` routes, with
idempotency keys on invoice/payment creation. The UI also surfaces the
collections agent: a tenant-wide **Agent activity** feed (`/agent`,
backed by `GET /v1/events`), a per-customer agent snapshot
(`GET /v1/customers/:id/agent`), and invoice-scoped event timelines.

**Auth is now option 2** (§3): a backend-for-frontend session layer —
per-tenant `users`, email + password login (`POST /v1/auth/login`), an
HttpOnly HMAC-signed session cookie, CSRF on cookie writes, a 5-role
model, admin `/v1/users` management, and per-user audit attribution on
`events_log` (see migrations 0010/0011, `src/auth/*`,
`src/gateway/middleware/session.ts`). Agents keep the tenant-API-key path;
`authenticate()` accepts either. CORS is now credentialed against an
`ALLOWED_ORIGINS` allowlist. Lives in [`../ui/`](../ui/), see its README.

Still not built: pagination/search in lists, Kanban boards, a ledger
entries list (and with it a reverse-entry UI), passkeys / password reset,
and per-route business-role gating (phase-2 gates only admin surfaces).

## 1. What exists to build on

One Worker, four native modules, one API key per tenant, no pagination, no
user accounts — just tenant-level bearer auth (`docs/architecture/phase-1-native.md`,
`src/gateway/middleware/auth.ts`). Full current surface:

| Module | Endpoints |
|---|---|
| Finance | `POST /v1/invoices`, `GET /v1/invoices`, `GET /v1/invoices/:id`, `POST /v1/invoices/:id/send`, `POST /v1/invoices/:id/reminder`, `POST /v1/payments`, `GET /v1/ledger/accounts`, `GET /v1/ledger/accounts/:id/balance`, `POST /v1/ledger/entries`, `GET /v1/ledger/entries/:id`, `POST /v1/ledger/entries/:id/reverse` |
| CRM | `GET/POST /v1/customers`, `GET /v1/customers/:id`, `GET /v1/customers/:id/payment-history`, `GET /v1/customers/:id/activities`, `GET /v1/deals/stages`, `GET/POST /v1/deals`, `GET /v1/deals/:id`, `POST /v1/deals/:id/stage`, `POST /v1/activities` |
| Support | `GET/POST /v1/tickets`, `GET /v1/tickets/:id`, `POST /v1/tickets/:id/messages`, `POST /v1/tickets/:id/status` |
| Build | `GET/POST /v1/projects`, `GET /v1/projects/:id`, `GET/POST /v1/issues`, `GET /v1/issues/:id`, `POST /v1/issues/:id/status` |

Everything an operator UI needs data-wise is already exposed. Nothing
below requires new business logic — it's UI + a handful of API-shape
gaps (§4).

## 2. Screens required (MVP scope)

- **Login / connect** — enter/paste a tenant API key (see §3 for why this is the hard part, not the easy part it sounds like).
- **Dashboard** — cross-module at-a-glance: open invoices total + overdue count, open deals value, open tickets by priority, active issues by status. All SQL joins already possible per the "one database" pitch in the README; needs one new aggregate endpoint or several parallel list calls.
- **Finance**
  - Invoice list (filter by status) → detail (lines, status, ledger postings) → actions: send, record payment, send reminder.
  - New invoice form (customer picker, line items).
  - Payment form (customer, amount, apply across invoices — this is the fiddliest form: many-to-many settlement UI).
  - Ledger: chart of accounts + balances, journal entry list/detail, manual entry form, reverse action.
- **CRM**
  - Customer list → detail (profile, payment history, activity feed).
  - New customer form.
  - Deal pipeline board (Kanban by stage, drag-to-move calls `POST /v1/deals/:id/stage`) or a simpler list+dropdown if a Kanban is too much for MVP.
  - Activity log entry form (note/call/email/meeting).
- **Support**
  - Ticket list (filter by status/priority) → detail (message thread, status transition buttons constrained to the legal-move table so the UI can't offer an illegal transition).
  - New ticket form.
- **Build**
  - Project list → detail.
  - Issue board (by status, similar Kanban-or-list question as deals) with status transition buttons (respecting the settled-state re-open rule).

That's ~14-16 screens/views for a genuinely complete MVP across all four
modules, plus the dashboard and auth screen.

## 3. The real scope driver: auth

This is the part likely to dominate effort, not the CRUD screens.

Today "auth" is one bearer token per tenant, no user identity, no roles,
no session model (`src/gateway/middleware/auth.ts` — hash the key, look up
tenant, cache in KV). That's fine for a script or an agent holding a secret
in an env var. It is **not fine for a browser**:

- A raw long-lived API key sitting in `localStorage`/cookies is exposed to
  XSS and cannot be scoped or revoked per-person — if any operator's laptop
  is compromised, the entire tenant's key is compromised.
- There's no concept of "which human did this" — every write looks
  identical in `events_log`/audit trails, which matters a lot once actual
  operators (plural) are clicking buttons that send money/reminders.
- There's no logout, no session expiry, no per-user permissions (e.g.
  "support agents can't touch the ledger").

Options, cheapest to most complete:
1. **Shared key, pasted once, stored in `sessionStorage`** — zero backend
   changes, ships fastest, but inherits every weakness above. Reasonable
   only for a single-operator internal tool with a trusted user base of one.
2. **Backend-for-frontend session layer** — a thin session (signed
   cookie) issued after checking a per-user password/passkey, which the
   BFF exchanges for the tenant API key server-side; browser never sees
   the real key. Requires a new `users` table, login endpoint, session
   middleware — meaningfully expands backend scope.
3. **Full per-user identity + roles** — proper accounts, RBAC, per-user
   API tokens with scopes, audit trail attribution. This is the "correct"
   long-term answer but is its own project, comparable in size to one of
   the existing native modules.

Recommendation for an MVP: **option 1** if this is truly for a single
trusted operator (you) to click around locally/in staging; **option 2** the
moment more than one person will use it or it touches production money.
Option 3 should be deferred until there's a concrete multi-operator need.

## 4. Backend gaps to close before/alongside the UI

None of these are large, but they're prerequisites, not nice-to-haves:

- **Pagination** — every `GET /v1/*` list endpoint returns the full
  unbounded result set today (confirmed: no `limit`/`offset`/`page` params
  anywhere in `src/gateway/routes/`). Fine for an agent doing a bounded
  query; not fine for a UI table against a tenant with thousands of
  invoices. Needs `?limit=&cursor=` on every list route.
- **Sorting/search** — list endpoints have status-only filters, no
  free-text search (find a customer by name, an invoice by id fragment).
  A UI needs at least customer/invoice/ticket search.
- **CORS** — the Worker currently assumes same-origin or trusted callers;
  a UI served from a different origin (or even a separate Worker/Pages
  project) needs explicit CORS headers on `/v1/*`.
- **Aggregate/dashboard endpoint** — the dashboard screen wants counts and
  sums across modules; either compose it client-side from several list
  calls (simplest, slightly chattier) or add one `GET /v1/dashboard`
  endpoint that does the joins server-side (cleaner, small new surface).
- **Field-level error shapes are already good** (`{error, code}` per
  module) — no changes needed there, just needs UI mapping to friendly
  messages.

## 5. Architecture options for the UI itself

- **Where it lives**: a separate static SPA (Vite + React or similar)
  deployed to Cloudflare Pages, calling the existing Worker's `/v1/*` API
  cross-origin — simplest to build and deploy independently of the
  Worker's release cycle. Alternative: serve it as static assets from the
  same Worker (Workers Static Assets) for a single deployable unit — saves
  a CORS story but couples UI and API releases.
- **Data layer**: given the API is small and REST-shaped, a lightweight
  fetch + cache layer (TanStack Query) is enough — no need for a generated
  client or GraphQL layer for this surface size.
- **Kanban boards** (deals, issues): nice-to-have, not required for MVP —
  a filterable list with a status-change dropdown covers the same
  functionality with far less UI engineering (drag-and-drop, optimistic
  reordering, collision handling on concurrent moves).

## 6. Effort estimate (rough, MVP = option 1 auth, no Kanban, no dashboard aggregate endpoint)

| Workstream | Rough size |
|---|---|
| Backend: pagination + search on list endpoints, CORS | Small |
| UI scaffold: routing, API client, design system basics, auth screen (option 1) | Small–Medium |
| Finance screens (invoice list/detail/create, payment form, ledger views) | Medium–Large (payment application UI is the fiddly part) |
| CRM screens (customers, deals as list, activities) | Medium |
| Support screens (tickets, thread, status buttons) | Small–Medium |
| Build screens (projects, issues as list, status buttons) | Small–Medium |
| Dashboard (client-composed, no new endpoint) | Small |
| **Total MVP** | **A few weeks of focused work**, dominated by Finance and by however much polish the payment-application form gets |

Adding Kanban boards, a dashboard aggregate endpoint, or option 2/3 auth
each adds meaningfully on top of this, roughly in that order of cost.

## 7. Open questions to resolve before starting

1. Who is the actual audience — one internal operator, or a team? This
   single-handedly decides the auth approach (§3) and therefore a large
   chunk of the schedule.
2. Is a Kanban board a real requirement or a nice-to-have? Recommend
   deferring it — the state-machine-constrained list view delivers the
   same control with far less engineering risk.
3. Does this UI need to be read/write from day one, or would a read-only
   dashboard (list/detail views, no forms) be a useful, much cheaper first
   milestone that also validates the pagination/CORS/API-client plumbing
   before investing in the write-side forms?

## 8. Recommendation

Given the project's stated agent-first philosophy, treat this as an
**internal operator console**, not a customer-facing product: start with
option-1 auth and a read-only dashboard + list/detail views across all
four modules (cheapest slice that's still useful), then layer in the
write forms (invoice/payment/ticket/issue creation, status transitions)
module by module, Finance last given it's the most involved form. Defer
Kanban boards and multi-user auth until there's a concrete need for either.
