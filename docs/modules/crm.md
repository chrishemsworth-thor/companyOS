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
| `GET /v1/customers?limit=&cursor=` | — | `{customers: [...], next_cursor}` |
| `POST /v1/customers` | `{name, email?, phone?}` | 201 customer |
| `GET /v1/customers/:id` | — | customer or 404 |
| `GET /v1/customers/:id/payment-history` | — | `{payments: [{payment_id, invoice_id, applied_cents, currency, received_at}]}` |
| `GET /v1/customers/:id/activities` | — | `{activities: [...]}` ordered by `occurred_at` |
| `GET /v1/deals/stages` | — | seeds + lists the pipeline |
| `GET /v1/deals?status=&limit=&cursor=` | — | `{deals: [...], next_cursor}` |
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

---

# Contact roles (PRD-003, S8)

Migration `0027_crm_depth.sql`. Contacts were undifferentiated: nothing said
that Aina signs quotes, Ravi pays invoices and Wei Ming is the day-to-day user.
That had an operational cost — the CollectionsAgent picked a contact without
knowing who controls payment.

## Shape

| Table | What it holds |
|---|---|
| `contacts` (`0013`) | The person. Unchanged except that `is_primary` is now **enforced**. |
| `contact_roles` (`0027`) | `(tenant_id, contact_id, role)`. Many-to-many both ways: a contact holds several roles, a customer has several contacts per role. |

`role` is `primary \| billing \| technical \| signatory \| other`, closed by
`contactRoleSchema` in `src/modules/crm/contact-roles.ts` and **not** by a SQL
`CHECK` — the same call 0022 made for `approvals.subject_type`, for the same
reason (widening a CHECK means a table rebuild, and 0022 documents why that is
effectively unavailable here). Adding a role is one array entry, no migration.

## The one invariant

**`contacts.is_primary = 1` if and only if the contact holds the `primary`
role.** PRD-003 asks for both a flag and a role; they are one fact, so
`normalizeRoles` collapses both possible inputs (`{is_primary: true}` and
`{roles: ["primary"]}`) before anything is written. Two representations that can
disagree is the bug this prevents.

Enforcement is layered:

- `roleWriteStatements` emits demote-then-promote statements that the caller
  runs in **one `db.batch()`** with the contact write.
- `CREATE UNIQUE INDEX idx_contacts_one_primary ON contacts (tenant_id,
  customer_id) WHERE is_primary = 1` is the backstop.

PRD-003 offers "clears the previous primary atomically (or 409 — pick one and
test it)". **S8 picked clear-atomically**, last-write-wins: a 409 would make a
routine hand-over a two-step operation for no safety gain.

## `resolveContact(db, tenantId, customerId, role)`

The documented fallback chain, and the only way any module should pick a person:

```
requested role -> primary -> any contact (oldest) -> null
```

Returns `{ contact, matched }` where `matched` is `"role" | "primary" | "any"`.
**The `matched` value is not decoration** — PRD-003 requires that a fallback be
*recorded on the decision*, so the CollectionsAgent puts it on
`collections.decision` and the reminder API returns it.

Returns `null` rather than throwing for a customer with no contacts: what a
missing contact means is the caller's decision.

Consumers today: the delivery port (`billing`) and the CollectionsAgent's
context assembly. S9's quote signing asks for `signatory`.

## Default roles on create

Stating no roles is normal, so the service supplies them: the customer's
**first** contact becomes `primary`, every later one `other`. That is the same
rule migration 0027 backfilled with, so a migrated tenant and a fresh one behave
identically. An empty `roles: []` counts as "not stated", not "clear them all".

## What changed in the delivery path

`sendReminder` used to read `customers.email/phone` and nothing else. It now
resolves the billing contact first and keeps the customer-level address as the
last rung — dropping that rung would have turned a working reminder into a
silent non-send for every tenant that has never created a contact row.
`deliveries.contact_id` records who was actually addressed.

### `customer.no_contact` and the word "gracefully"

When nothing resolves, dispatch emits `customer.no_contact.v1` **and then throws
`DeliveryError("no_recipient")` as before.** PRD-003's criterion says "fails
gracefully with a `customer.no_contact` event rather than throwing", and this is
the reading that holds up: swallowing the error would make
`POST /v1/invoices/:id/reminder` answer 202 for a send that never happened. The
CollectionsAgent already treats `DeliveryError` as a graceful non-send — it logs,
keeps tracking, and does not record a contact that never occurred. Graceful means
no unhandled exception and an observable event, not a false 2xx.

The event has **no `NOTIFICATION_MAP` entry**: the notification consumer must not
query D1 to find a recipient (on the free plan it runs inline with the emitting
request) and there is no user id on the payload.

## Console

Role checkboxes on `ContactFormModal`, role badges on the customer detail
contacts table. The standalone "Primary contact" checkbox was **removed** rather
than kept alongside the roles — one fact, one control.

---

## Service layer (`src/modules/crm/service.ts`)

`ensureDefaultStages`, `listStages`, `createCustomer`, `getCustomer`,
`listCustomers`, `getPaymentHistory`, `createDeal`, `getDeal`, `listDeals`,
`changeDealStage`, `logActivity` (row + event), `insertActivityRow` (row only,
for agents), `listActivities`, `createContact`/`updateContact`/`listContacts`
(roles-aware). Throws `CrmError`. Roles themselves live in
`src/modules/crm/contact-roles.ts`.

## Contact & role API

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /v1/customers/:id/contacts` | — | `{contacts: [...]}`, each with `roles[]` |
| `POST /v1/customers/:id/contacts` | `{name, title?, department?, email?, phone?, roles?, is_primary?}` | 201 contact |
| `PATCH /v1/customers/:id/contacts/:contactId` | any of the above | contact or 404 |
| `GET /v1/customers/:id/contacts/resolve?role=` | `role` (default `primary`) | `{contact, matched, requested_role}`; `contact: null` **with 200** when the customer has no contacts, 404 only for an unknown customer |

## Tests

`test/crm.test.ts` — customer CRUD, native payment-history through a real
invoice→payment flow, default-pipeline seeding idempotency, deal creation and
won-stage settlement, unknown customer/stage rejection, status filtering,
activity logging, and the CollectionsAgent's `reminder_sent` rows appearing in
the customer's activity feed.

`test/contact-roles.test.ts` — every PRD-003 contact-roles acceptance criterion,
the four-outcome resolution chain, the primary invariant under repeated
hand-over, and tenant isolation on both the list and the resolve surfaces.

`test/migration-contact-roles.test.ts` — the schema properties 0027 was supposed
to produce, the unique index enforcing one primary at the storage layer, and the
backfill's ranking rule against all three pre-0027 states.

`ui/src/components/modals/ContactFormModal.test.tsx` — role selection, and that
the old standalone primary checkbox is gone.
