# CRM Module

Native customers, deal pipeline, and activity log. Replaces Twenty CRM.
`source_module: sales`.

**In scope:** customer records, deals moving through a per-tenant pipeline,
an append-only activity log shared with agents.
**Out of scope (for now):** leads-vs-contacts distinction, email sync,
custom fields, forecasting.

## Data model (`migrations/0001_init.sql`, `migrations/0003_crm.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `customers` | Root entity shared with finance/support | `customer_id` (`cust_`), `name`, `email`, `phone`, `created_at` |
| `pipeline_stages` | Per-tenant stages | `stage_id` (`stg_`), `name` (unique per tenant), `sort_order`, `is_won`, `is_lost` |
| `deals` | Opportunities | `deal_id` (`deal_`), `customer_id` (FK), `title`, `value_cents`, `currency`, `stage_id` (FK), `status` (`open\|won\|lost`) |
| `activities` | **Append-only** touch log | `activity_id` (`act_`), `customer_id`, `deal_id?`, `kind` (`note\|call\|email\|meeting\|reminder_sent`), `body`, `occurred_at` |

## Business rules

- **Default pipeline** seeded per tenant on first use (idempotent via
  `UNIQUE (tenant_id, name)`): Lead → Qualified → Proposal → Won (`is_won`)
  → Lost (`is_lost`).
- **Stage-driven settlement:** moving a deal to a stage flagged `is_won` /
  `is_lost` sets its `status` to `won`/`lost` and emits `deal.won`/`deal.lost`
  on top of `deal.stage_changed`. Any other stage keeps/returns it to `open`.
- **Deals require an existing customer** (404 otherwise); omitting `stage_id`
  places the deal in the first stage.
- **Collections is CRM-visible:** the CollectionsAgent writes a
  `reminder_sent` row into `activities` for every reminder it sends
  (`insertActivityRow`, no duplicate bus event) — payment-chasing history sits
  next to notes and calls with zero integration.
- **Native payment history:** `GET /v1/customers/:id/payment-history` is a
  join over `payments` × `payment_applications` (owned by the finance module),
  replacing the old Frappe API call — the payoff of one shared database.

## API

Auth as everywhere (`Bearer <tenant_api_key>`). `CrmError` maps to 404
(`not_found`) and 422 (`invalid_stage`).

| Method & path | Body | Returns |
|---|---|---|
| `GET /v1/customers` | — | `{customers: [...]}` |
| `POST /v1/customers` | `{name, email?, phone?}` | 201 customer |
| `GET /v1/customers/:id` | — | customer or 404 |
| `GET /v1/customers/:id/payment-history` | — | `{payments: [{payment_id, invoice_id, applied_cents, currency, received_at}]}` |
| `GET /v1/customers/:id/activities` | — | `{activities: [...]}` ordered by `occurred_at` |
| `GET /v1/deals/stages` | — | seeds + lists the pipeline |
| `GET /v1/deals?status=` | — | `{deals: [...]}` |
| `POST /v1/deals` | `{customer_id, title, value_cents, currency, stage_id?}` | 201 deal |
| `GET /v1/deals/:id` | — | deal or 404 |
| `POST /v1/deals/:id/stage` | `{stage_id}` | deal with updated stage/status |
| `POST /v1/activities` | `{customer_id, deal_id?, kind, body?, occurred_at?}` | 201 activity |

## Events emitted

| Event | Version | Payload | When |
|---|---|---|---|
| `customer.created` | v1 | `customer_id, name, email?, phone?` | `createCustomer` |
| `deal.created` | v1 | `deal_id, customer_id, title, value_cents, currency, stage_id` | `createDeal` |
| `deal.stage_changed` | v1 | `deal_id, customer_id, from_stage, to_stage` | `changeDealStage` |
| `deal.won` / `deal.lost` | v1 | `deal_id, customer_id, value_cents, currency` | stage change landing on a won/lost stage |
| `activity.logged` | v1 | `activity_id, customer_id, deal_id?, kind, occurred_at` | `logActivity` (API path; agent rows skip the event) |

None route to an agent yet — all audit-logged in `events_log`. A future
SalesAgent claims them via `AGENT_ROUTES` in `src/queue/consumer.ts`.

## Service layer (`src/modules/crm/service.ts`)

`ensureDefaultStages`, `listStages`, `createCustomer`, `getCustomer`,
`listCustomers`, `getPaymentHistory`, `createDeal`, `getDeal`, `listDeals`,
`changeDealStage`, `logActivity` (row + event), `insertActivityRow` (row only,
for agents), `listActivities`. Throws `CrmError`.

## Tests

`test/crm.test.ts` — customer CRUD, native payment-history through a real
invoice→payment flow, default-pipeline seeding idempotency, deal creation and
won-stage settlement, unknown customer/stage rejection, status filtering,
activity logging, and the CollectionsAgent's `reminder_sent` rows appearing in
the customer's activity feed.
