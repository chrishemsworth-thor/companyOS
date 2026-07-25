# PRD-001 — Finance: Ledger Dimensions, Tax, Credit Notes

**Status:** Not started · **Priority:** P0 (dimensions are urgent — see Timeline)
**Depends on:** nothing · **Blocks:** project profitability, per-client margin

---

## Problem Statement

The general ledger is structurally sound — double-entry, append-only, reversal-only
corrections, integer cents, atomic balanced writes. The quote → invoice → payment
path works end to end. But journal lines currently carry account and amount without
**analytical dimensions**, which means the ledger can produce a P&L and cannot produce
project profitability, per-client margin, or department cost analysis.

Those cross-module rollups are the strongest differentiation CompanyOS has against
any assembled stack, and they are impossible without dimensions on the line. Adding
dimensions to a ledger that already contains customer financial data is painful and
partly un-backfillable. There is currently no real customer data. This is the cheapest
this change will ever be.

Two further gaps block Malaysian commercial use: SST is only modelled as header-level
tax on quotes (not in the ledger), and there is no credit note path.

## Goals

1. Every journal line can carry customer, project, department, and employee dimensions,
   enabling any profitability rollup as a SQL query rather than a new feature.
2. SST is representable end to end — on the quote, on the invoice, and as a distinct
   liability account in the ledger — so a tenant's tax position is derivable.
3. Credit notes exist as a first-class, append-only-compatible correction path,
   distinct from journal reversal.
4. No change to the append-only or balance-enforcement guarantees.
5. Ledger multi-currency is explicit: functional currency per tenant, transaction
   currency and rate stored on the line.

## Non-Goals

- **Full tax filing / SST-02 return generation.** Out of scope — capture the data
  correctly now, generate returns when a customer asks.
- **Automatic FX revaluation at period end.** P2. Store rates; do not revalue.
- **Fixed assets, depreciation schedules, inventory.** Separate initiatives.
- **Bank feed / statement reconciliation.** Separate initiative; dimensions do not
  depend on it.
- **Period close / locking.** Append-only already prevents mutation; formal period
  locking is P2.

## User Stories

- As an agency owner, I want costs and revenue tagged to a project so that I can see
  which client engagements are actually profitable.
- As a finance operator, I want to issue a credit note against an invoice so that I
  can correct an overbill without the customer receiving a confusing reversal entry.
- As a finance operator, I want SST charged on an invoice to land in a tax liability
  account so that I know what I owe.
- As an agent, I want to query margin by customer through `/v1/insights` so that I can
  reason about which customers are worth chasing.
- As a finance operator, I want a foreign-currency invoice recorded at its transaction
  rate so that the ledger stays in functional currency.

## Requirements

### P0 — Ledger dimensions

- Add nullable columns to the journal **line** table: `customer_id`, `project_id`,
  `department_code`, `employee_id`, `cost_centre` (free text, reserved).
- All are nullable — existing entries remain valid, no backfill required.
- `department_code` validates against the existing 11-department taxonomy.
- Dimensions are set automatically where derivable: invoice postings inherit
  `customer_id`; expense claim postings (PRD-006) inherit `employee_id` and
  `department_code`; project-linked entries inherit `project_id`.
- Manual journal entries accept dimensions via API and console.
- Dimensions are **immutable once posted**, consistent with append-only. Correcting a
  mis-tagged entry is a reversal plus a re-post.
- Index on `(tenant_id, project_id)` and `(tenant_id, customer_id)`.

**Acceptance criteria**
- [ ] Given an invoice created for customer X, then both the AR and Revenue lines
      carry `customer_id = X`.
- [ ] Given a manual journal entry with `project_id` set, when retrieved, then the
      dimension persists on each line.
- [ ] Given a posted entry, when a dimension update is attempted, then it is rejected
      (SQL trigger, same mechanism as append-only).
- [ ] Given an entry with no dimensions, then it posts successfully (backwards compatible).
- [ ] Given a `department_code` not in the taxonomy, then 400.

### P0 — Profitability rollups in Insights

- `GET /v1/insights/profitability?group_by=project|customer|department` returning
  revenue, direct cost, margin, margin %.
- Read-only SQL over the dimensioned ledger. No new write path.
- Console: a Profitability view on the Insights page.

**Acceptance criteria**
- [ ] Given revenue and cost entries tagged to project P, then the rollup returns
      revenue − cost as margin for P.
- [ ] Given entries with no project, then they appear under an explicit "Unallocated"
      bucket rather than being silently dropped.

### P0 — Tax (SST)

- `tax_rates` table per tenant: `code, name, rate_bps, type (sales|service|exempt|zero),
  effective_from, effective_to`. Seed Malaysian defaults but keep fully editable —
  do not hardcode rates.
- Tax at **line level** on invoices and quotes (header-level tax cannot represent a
  mixed-rate invoice). Header total is the sum.
- Invoice posting becomes: Dr AR (gross) / Cr Revenue (net) / Cr SST Payable (tax).
  Add `SST Payable` to the seeded system chart of accounts.
- Tax amount, rate, and code stored on the invoice line so a historical invoice is
  reproducible after a rate change.
- Rounding: compute tax per line, round each to the cent, sum. Document this — do not
  compute on the header total and allocate back.

**Acceptance criteria**
- [ ] Given an invoice with two lines at different rates, then the posting has one
      SST Payable credit equal to the sum of per-line tax, and the entry balances.
- [ ] Given a rate change after an invoice is issued, when the invoice is re-rendered,
      then the original rate is shown.
- [ ] Given a zero-rated line, then no tax line is posted for it.
- [ ] Given the tax and net credits, then they sum exactly to the AR debit (no rounding drift).

### P0 — Credit notes

- Credit note entity referencing an invoice: line items, reason, lifecycle
  (draft → issued), own numbering sequence.
- Issuing posts Dr Revenue / Dr SST Payable / Cr AR — a real transaction, not a
  reversal, so both documents remain in the customer's history.
- Partial credits allowed; total credited cannot exceed the invoice total.
- A fully credited invoice moves to a `credited` state and is **excluded from the
  overdue sweep and from the CollectionsAgent's open-invoice context**.
- Emits `credit_note.issued.v1`.

**Acceptance criteria**
- [ ] Given a RM1,000 invoice, when a RM300 credit note is issued, then the customer's
      AR balance is RM700 and both documents appear in the timeline.
- [ ] Given an attempt to credit more than the invoice total, then 400.
- [ ] Given a fully credited overdue invoice, when the daily sweep runs, then no
      `invoice.overdue` event is emitted for it.
- [ ] Given a credit note on a paid invoice, then it posts and the resulting negative
      AR is visible (customer is in credit).

### P0 — Ledger multi-currency

- Tenant functional currency (exists, default MYR) is the ledger currency.
- Journal lines store `txn_currency`, `txn_amount_cents`, `fx_rate` alongside the
  functional-currency amount. Balance enforcement applies to functional amounts only.
- Rates entered manually per transaction in v1. No rate feed.

**Acceptance criteria**
- [ ] Given a USD invoice with a stated rate, then the ledger entry is in MYR and
      the USD amount and rate are recoverable from the line.
- [ ] Given lines in mixed currencies, then balance is enforced on functional amounts.

### P1

- Dimension filters on the ledger browse view in the console.
- Budget vs actual by department.
- Tax summary report (output tax collected by period) — data foundation for SST-02.

### P2 (design for, do not build)

- Period close / locking.
- FX revaluation.
- Multi-entity consolidation — keep `tenant_id` as the entity boundary so an
  `entity_id` can be layered later.

## Success Metrics

- Project profitability for a seeded agency scenario is answerable in one SQL query.
- Zero changes to append-only guarantees; existing ledger tests pass unmodified.
- A mixed-rate, multi-line, partially-credited invoice reconciles to the cent.

## Open Questions

- **(Product, blocking)** Should direct cost for profitability come only from
  dimensioned expense entries, or also from an employee cost rate × logged time?
  There is no time tracking module — if profitability needs it, that is a separate PRD
  and this one only delivers revenue-side and expense-side rollups.
- **(Legal/Finance, non-blocking)** Confirm current Malaysian SST rates and service
  tax scope for SaaS and agency services before seeding defaults. Seed values are a
  starting point, not advice.
- **(Engineering, non-blocking)** Does `credited` need to be a distinct invoice state,
  or is it derivable from credit note totals? Derived is cleaner but complicates the
  sweep query.

## Timeline Considerations

**Dimensions should be done first and soon.** Every day of real customer data makes
this migration more expensive and less backfillable. Suggested phasing:

1. Dimensions + profitability rollup (do this before any customer onboards)
2. Tax
3. Credit notes
4. Multi-currency on the line

Tax and credit notes can be reordered based on which a design partner hits first.
