# Finance Module

Native invoicing, payments, and a double-entry ledger. Replaces ERPNext's
finance surface (the plan the greenfield pivot retired). `source_module: finance`.

**In scope:** invoices with line items, payments with many-to-many settlement,
a balanced append-only general ledger, daily overdue detection, agent-composed
reminders.
**Deliberately out of scope:** tax, multi-currency conversion (single currency
per journal entry, `CHECK`ed), depreciation, budgeting, full ERP workflows.
Anything else is expressible as a `manual` journal entry.

## Data model (`migrations/0001_init.sql`, `migrations/0002_finance_ledger.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `accounts` | Chart of accounts, per tenant | `account_id` (`acct_`), `code` (unique per tenant), `type` (`asset\|liability\|equity\|revenue\|expense`), `is_system` |
| `journal_entries` | Ledger headers, **append-only** | `entry_id` (`je_`, ULID → time-sortable), `entry_date`, `currency`, `source_type` (`invoice\|payment\|manual\|reversal`), `source_id`, `reverses_entry_id` |
| `journal_lines` | One debit/credit per row, **append-only** | `line_no`, `account_id`, `amount_cents` (signed: > 0 debit, < 0 credit, never 0) |
| `invoices` | Mutable lifecycle header | `invoice_id` (`inv_`), `status`, `total_cents`, `amount_due_cents`, `due_date`, `issued_at`/`sent_at`/`paid_at` |
| `invoice_lines` | Line items | `description`, `quantity`, `unit_cents` |
| `payments` | Received payments | `payment_id` (`pay_`), `amount_cents`, `method`, `received_at`, `entry_id` (ledger backlink) |
| `payment_applications` | Many-to-many settle: one payment ↔ several invoices | `applied_cents` |

All money is INTEGER cents; all PKs are composite `(tenant_id, id)`;
timestamps are ISO-8601 TEXT.

### System chart of accounts

Seeded per tenant on first use, idempotently (`ensureSystemAccounts`):
`1000` Cash, `1100` Accounts Receivable, `2000` Accounts Payable,
`3000` Owner's Equity, `4000` Revenue, `5000` General Expenses.

## Ledger invariants

1. **Balanced entries** — every journal entry has ≥ 2 lines summing to exactly
   0, enforced in `src/modules/finance/ledger.ts` before an atomic
   `env.DB.batch(...)`; unbalanced input never writes anything.
2. **Append-only** — SQL `RAISE(ABORT)` triggers block UPDATE/DELETE on
   `journal_entries`/`journal_lines`. Corrections are reversal entries
   (`source_type='reversal'`, `reverses_entry_id` backlink) that negate the
   original lines.
3. **Posting rules** (minimal by design):
   - invoice issued → Dr `1100` AR / Cr `4000` Revenue for `total_cents`
   - payment received → Dr `1000` Cash / Cr `1100` AR for `amount_cents`
4. **Overpayment guard** — an application can never exceed the invoice's
   `amount_due_cents`; the applications of a payment must sum exactly to its
   `amount_cents`.

## Invoice lifecycle

```
draft ──send──▶ sent ──cron sweep (due_date passed)──▶ overdue
  │                └──────────────┬──────────────────────┘
  └── (issue posts AR/Revenue)    ▼ payment applications
                       partially_paid ──▶ paid   (cancelled: reserved)
```

The **overdue sweep** (`src/modules/finance/overdue-sweep.ts`) runs daily at
01:00 UTC (cron in `wrangler.jsonc`): marks past-due `sent` invoices `overdue`
and re-emits `invoice.overdue` for *everything* still overdue. Re-emission is
deliberate — it re-nudges the CollectionsAgent daily and is the safety net for
the deferred outbox (see `docs/architecture/phase-1-native.md`).

## API

All routes require `Authorization: Bearer <tenant_api_key>`. Errors carry
`{error, code}`; `FinanceError` maps to 404 (`not_found`), 409
(`invalid_status`), or 422 (`invalid_total`, `amount_mismatch`, `overpayment`,
`customer_mismatch`, `currency_mismatch`).

`POST /v1/invoices` and `POST /v1/payments` honor an optional
`Idempotency-Key` header (see [Idempotency keys](#idempotency-keys) below).
`GET /v1/invoices` supports cursor pagination (see
[Cursor pagination](#cursor-pagination)).

| Method & path | Body | Returns |
|---|---|---|
| `POST /v1/invoices` | `{customer_id, currency, due_date, lines: [{description, quantity, unit_cents}]}` | 201 invoice (status `draft`, ledger posted) |
| `GET /v1/invoices?status=&limit=&cursor=` | — | `{invoices: [...], next_cursor}` |
| `GET /v1/invoices/:id` | — | invoice + `lines` |
| `POST /v1/invoices/:id/send` | — | invoice (`sent`); 409 unless `draft` |
| `POST /v1/invoices/:id/reminder` | `{channel: "email"\|"whatsapp", message?}` | 202 `{status, delivery_ref, channel, provider}` via the DeliveryProvider port; 422 `no_recipient` if the customer has no email/phone, 502 `send_failed` on provider errors |
| `POST /v1/payments` | `{customer_id, amount_cents, currency, method?, received_at?, applications: [{invoice_id, applied_cents}]}` | 201 `{payment_id, entry_id}` |

### Idempotency keys

Pass `Idempotency-Key: <opaque string>` on `POST /v1/invoices` or
`POST /v1/payments` to make a retry safe. The response is keyed on
`(tenant_id, endpoint, key)`:

- Unseen key → runs normally, and the response (success or an expected
  `FinanceError`) is cached against the key.
- Same key, identical body → the cached response is replayed; the write does
  not run again.
- Same key, different body → `422 key_reused`.
- Same key, still being processed by a concurrent request → `409 in_progress`.

This is the one workstream4 change agents should adopt before being given
retry authority — double-recording a payment is the worst outcome in this
system, and a naive retry-on-timeout otherwise risks exactly that.

### Cursor pagination

List endpoints accept `?limit=` (default 50, max 200) and `?cursor=`.
Entity IDs are ULIDs — lexicographically sortable by creation time — so
pages are ordered `id ASC` and the cursor is the last id seen. The response
includes `next_cursor`; `null` means there is no further page.
| `GET /v1/ledger/accounts` | — | seeds + lists the chart |
| `GET /v1/ledger/accounts/:id/balance` | — | `{balance_cents}` (signed sum) |
| `POST /v1/ledger/entries` | `{entry_date, currency, memo?, lines: [{account_id, amount_cents}]}` | 201 `{entry_id}`; unbalanced → 422 |
| `GET /v1/ledger/entries/:id` | — | header + ordered lines |
| `POST /v1/ledger/entries/:id/reverse` | — | 201 `{entry_id}` of the reversal |

## Events emitted

| Event | Version | Payload | When |
|---|---|---|---|
| `invoice.created` | v1 | `invoice_id, customer_id, total_cents, currency, due_date` | `createInvoice` |
| `invoice.sent` | v1 | `invoice_id, customer_id, sent_at` | `sendInvoice` |
| `invoice.overdue` | v2 | `invoice_id, customer_id, amount_due_cents, currency, days_overdue` | daily sweep (re-emitted while unpaid) |
| `payment.received` | v2 | `payment_id?, invoice_id, customer_id, amount_paid_cents, currency` | `recordPayment`, per fully settled invoice |
| `payment.partial` | v1 | `payment_id, invoice_id, customer_id, amount_paid_cents, remaining_cents, currency` | `recordPayment`, per partially settled invoice |
| `collections.decision` | v1 | `customer_id, risk_score, action, channel, message, source, trigger` | CollectionsAgent, every assessment (LLM or fallback) — the audit trail |
| `customer.risk_flagged` | v1 | `customer_id, risk_score, open_invoices, total_due_cents` | CollectionsAgent, on the transition into `escalated` |

`invoice.overdue` and `payment.received` route to the `CollectionsAgent`
Durable Object (per tenant+customer); the rest are audit-logged in
`events_log`.

## Service layer

- `src/modules/finance/ledger.ts` — `ensureSystemAccounts`, `listAccounts`,
  `getAccountByCode`, `accountBalance`, `postEntry` (validate + atomic batch),
  `buildEntryStatements` (compose the entry into a larger batch — how invoice
  and payment writes stay atomic with their postings), `getEntry`,
  `reverseEntry`. Throws `LedgerError` (`unbalanced`, `too_few_lines`,
  `unknown_account`).
- `src/modules/finance/service.ts` — `createInvoice`, `sendInvoice`,
  `getInvoice`, `listInvoices`, `getInvoiceLines`, `recordPayment`. Pattern:
  validate → one `env.DB.batch(...)` → `makeEnvelope(...)` →
  `env.EVENTS.send(...)`. Throws `FinanceError`.
- `src/modules/finance/overdue-sweep.ts` — `runOverdueSweep(env, now?)`,
  called from the `scheduled` handler in `src/index.ts`; takes an injectable
  `now` for tests.

## Tests

- `test/finance-ledger.test.ts` — the invariant suite: unbalanced → 422 +
  zero rows written (batch atomicity), append-only triggers abort
  UPDATE/DELETE, reversal restores prior balance, global
  `GROUP BY entry HAVING SUM(amount_cents) != 0 → empty` after a mixed op
  sequence.
- `test/finance-service.test.ts` — invoice/payment lifecycle: AR/Revenue and
  Cash/AR postings, partial payments, overpayment/mismatch rejection,
  multi-invoice settlement.
- `test/finance-lifecycle.test.ts` — the vertical slice: create → send →
  sweep → queue consumer → CollectionsAgent state → payment resets it.
