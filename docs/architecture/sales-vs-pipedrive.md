# Sales & BD vs. Pipedrive — a feature comparison

*Written 2026-08-19. Compares the CompanyOS `crm` module (`source_module: sales`)
plus its neighbours (`quotes`, `insights`, `delivery`, `enrichment`) against
[Pipedrive](https://www.pipedrive.com/), the incumbent SME sales CRM.*

> Companion to [`sales-module-design.md`](./sales-module-design.md), which
> benchmarks the same module against Apollo.io. Apollo is the reference for
> *outbound prospecting*; Pipedrive is the reference for *the sales CRM a 5–50
> person company actually buys*. That makes it the closer competitor for the
> Malaysian SME segment CompanyOS is aimed at, and the harder comparison.

---

## 1. The one-paragraph answer

**We are not a Pipedrive replacement today, and on Pipedrive's own turf we are
behind by a wide margin.** Pipedrive is a mature, decade-plus sales-rep tool with
custom fields, multiple pipelines, two-way email sync, a workflow automation
builder, forecasting, web forms, campaigns and 500+ integrations. CompanyOS's
Sales module is a *correct, thin, event-emitting spine* — customers, contacts
with roles, leads, one pipeline, deals, an append-only activity log — with no
rep-productivity layer on top of it and, critically, **no agent working it**.

Where we are genuinely ahead is not feature count but **shape**: our sales record
is joined to the general ledger, support tickets and quotes in one database, so a
customer's health band is derived from real AR ageing, DSO against their own
payment terms, and open tickets — facts a standalone CRM cannot see without an
integration project. That is the thing to build on. Matching Pipedrive
field-for-field is not.

---

## 2. What we have today

Verified against the code, not the roadmap.

| Capability | Where | Notes |
|---|---|---|
| Customers | `migrations/0001`, `0027` | Root entity shared with finance/support. Industry, website, payment terms, credit limit, preferred channel, shipping address, notes. |
| Contacts + **roles** | `src/modules/crm/contact-roles.ts` | `primary \| billing \| technical \| signatory \| other`, many-to-many, with a documented `resolveContact` fallback chain and a recorded `matched` value. |
| Leads | `migrations/0018`, `src/gateway/routes/leads.ts` | `new → qualified → converted/lost`, free-text `source`, **one-call conversion** to customer + contact + deal with lineage ids. |
| Enrichment | `src/enrichment/` | A port with a **no-op default**. Real providers slot in behind `ENRICHMENT_PROVIDER`; none ship. |
| Deal pipeline | `migrations/0003` | Per-tenant stages with `sort_order`, `is_won`, `is_lost`. Stage moves settle status and emit `deal.won` / `deal.lost`. |
| Activity log | `migrations/0003` | Append-only: `note \| call \| email \| meeting \| reminder_sent`. Shared by humans and agents. |
| **Customer health** | `src/modules/crm/health.ts`, `signals.ts` | Derived band + *reasons* (never a bare score), from one cross-module query: AR ageing, DSO vs. the customer's own terms, open/ageing tickets, activity recency, credit limit. |
| Quote-to-cash | `src/modules/quotes/` | Line items, per-line discounts, header tax, branded server-rendered document, expiry cron, one-call conversion to invoice. |
| Pipeline reporting | `src/modules/insights/service.ts` | `pipelineByStage`, plus AR ageing, revenue by month, profitability by customer/project/department. |
| Outbound send | `src/delivery/` | Console / Resend / Twilio / Gmail providers behind one port. |
| Audit trail | `events_log`, `src/schemas/events/` | Every sales mutation is a versioned, replayable event. Pipedrive has a changelog; it does not have this. |
| RBAC | `src/auth/capabilities.ts` | 6 roles against a capability matrix, enforced in middleware. |

## 3. What Pipedrive has that we do not

Ordered by how often it is the reason a deal is lost, not by build cost.

| Pipedrive capability | CompanyOS status | Severity |
|---|---|---|
| **Custom fields** on deals/contacts/organisations | **Nothing.** No custom-field mechanism anywhere in the codebase. Every tenant gets our columns. | 🔴 Blocker for most evaluations |
| **Multiple pipelines** | One per tenant — `pipeline_stages` has no `pipeline_id`, and `UNIQUE (tenant_id, name)` assumes a single stage set. | 🔴 Blocker for any two-motion sales team |
| **Scheduled activities / tasks** with due dates, reminders, calendar sync | Our `activities` row is a *past* touch: `occurred_at`, no `due_at`, no assignee, no done flag. We log history; we do not drive a rep's day. | 🔴 This is Pipedrive's core daily loop |
| **Deal ownership** — owner, expected close date, probability, rotting alerts, lost reasons | None of these columns exist. A deal is title + value + stage + status. | 🔴 |
| **Two-way email sync** threaded onto the record, templates, open/click tracking | Outbound send works; inbound Gmail sync is **metadata-only bus events** (`email.received`), not threaded onto a customer. | 🟠 |
| **Workflow automation builder** (drag-and-drop triggers → actions) | We have events + a queue, which is the *substrate* for this, but no rule engine and no UI. | 🟠 |
| **Revenue forecasting / recurring revenue / goals** | `pipelineByStage` sums open deals by stage. No weighting, no close dates, so no forecast is even derivable. | 🟠 |
| **Lead scoring & routing**, web forms, chatbot, prospector (LeadBooster) | Leads are hand-entered or imported. No scoring, no routing, no capture surface. | 🟠 |
| **Email campaigns** (Campaigns add-on) | No marketing module at all — `direction.md` names Marketing as whitespace. | 🟡 |
| **Products / price-book** | Quote lines are free-text `item_name` + `unit_cents`. No product entity, no price list, no per-product reporting. | 🟡 |
| **E-signature** (Smart Docs) | Quote documents render a signature *block*. Nobody signs anything electronically. | 🟡 |
| **Import / export / dedup / merge** | No bulk import path, no duplicate detection, no merge. Migrating a real tenant in is manual. | 🟡 |
| **Mobile apps** | Console is a responsive web app; no native app, no offline. | 🟡 |
| **Marketplace / 500+ integrations** | Google (Gmail) and generic webhook ingestion. | 🟡 |
| **AI assistant across the product** (Pulse, AI report authoring, email drafting, deal summaries) | We have an LLM port and agent infrastructure, applied to collections only. | 🟠 — see §5 |

## 4. What we have that Pipedrive does not

This is the short list, and it is the whole argument.

1. **The record is joined to the ledger.** `getCustomerSignals` answers "what is
   outstanding, how overdue, how slowly do they pay relative to their own terms,
   how many tickets are open" in **one SQL query**, because invoices, tickets,
   activities and deals live in one database. In Pipedrive this is an
   integration project with a sync layer, and it still cannot compute DSO.
2. **Health as reasons, not a score.** `computeHealth` returns a band whose
   severity is the max of its reasons, each machine-readable and each naming the
   invoice ids behind it. Pipedrive's AI surfaces suggestions; it does not have
   the accounting facts to derive this.
3. **Role-resolved contacts.** `resolveContact(customer, "billing")` with a
   recorded fallback chain means an automated send addresses the person who
   controls payment, and the decision records *how* it picked them.
4. **Quote → invoice → ledger in one hop.** Accepting a quote converts to an
   invoice that posts to a double-entry GL. Pipedrive stops at the document and
   hands off to an accounting tool.
5. **Agent-first API.** Every capability is a normalized `/v1` endpoint with
   versioned events, designed for an agent as the primary consumer. Pipedrive's
   API is a REST surface over a UI-first product.
6. **One tenant, one database, one auth model** — no per-app seats, no sync lag,
   no field-mapping drift.

## 5. The gap that actually matters

Pipedrive's weakest publicly-noted area is **advanced AI**: reviewers
consistently note it lacks forecasting models, lead scoring and next-best-action.
It has AI drafting and AI-authored reports bolted onto a rep-productivity tool.

That is precisely the axis CompanyOS is built for — and precisely where we have
shipped nothing. Sales today emits five event types and **routes none of them to
an agent**: `AGENT_ROUTES` in `src/queue/consumer.ts` still maps two event types,
both to collections. Every deepening we have shipped (leads, contact roles,
health, quotes) made the *record* richer and left the module inert.

So the honest scoreboard:

- On **Pipedrive's axis** (rep productivity, configurability, integrations) we
  are years behind and should not compete head-on.
- On **our axis** (an agent that works the pipeline off ledger-grade context) we
  are ahead in architecture and tied at zero in shipped behaviour.

## 6. Recommended posture

**Do not chase parity.** Two tracks, in this order:

1. **Ship the differentiator** — [PRD-010](../prd/PRD-010-sales-agent.md)
   (sequences + SalesAgent, scheduled S15, gated on PRD-002 guardrails). Until an
   agent advances a pipeline autonomously, the architectural argument in §4 is
   unproven and every comparison reduces to a feature checklist we lose.
2. **Close only the table-stakes gaps that block evaluations** — in this order,
   because these are the ones a prospect notices in the first ten minutes:
   - **Custom fields** (a typed key/value sidecar; no per-tenant DDL).
   - **Multiple pipelines** (`pipeline_id` on stages + deals).
   - **Scheduled activities** (`due_at`, `assignee`, `completed_at` on the
     activity row) — this also gives the SalesAgent something to *schedule*, so
     it pays for itself twice.
   - **Deal owner, expected close date, lost reason** — three columns that
     unlock weighted forecasting from data we would then have.

Everything else in §3 — campaigns, web forms, e-signature, marketplace, mobile —
is deliberately not ours to build soon, and several (a contact database, dialer,
LinkedIn automation) are already explicit non-goals in PRD-010.

---

*Pipedrive capability claims in §3 are drawn from public 2026 product reviews and
Pipedrive's own product pages; CompanyOS claims are drawn from the code and
migrations cited inline and were verified against the tree at the time of
writing.*
