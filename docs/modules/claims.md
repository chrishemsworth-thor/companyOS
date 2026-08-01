# Expense claims

PRD-006a. An employee photographs a receipt on their phone; a manager approves
it; a balanced journal entry lands in the general ledger with employee, project
and department dimensions, moving both the cash position and the project's
margin. That chain is the point — PRD-006 is blunt about it: *"no standalone HR
product can do that, because they do not own the books. That is the demo."*

Migration `0024_expense_claims.sql`. Three tables and no primitives of its own:
approvals come from PRD-000b, receipts from PRD-000a, notifications from
PRD-000c, dimensions from PRD-001a.

## Shape

| Table | What it holds |
|---|---|
| `claim_categories` | Per tenant: name, kind (`standard` \| `mileage`), per-km rate, per-claim limit, and **the GL expense account it posts to**. That mapping is what makes posting possible. |
| `expense_claims` | Header: employee, date, currency, totals, status, claim-level project/department, the approval id, the posting's `entry_id`, the reimbursement's `paid_entry_id`. |
| `expense_claim_lines` | One receipt each. Category, amount (gross), tax, `receipt_file_id` (**NOT NULL**), optional per-line project/department override. |

### Lifecycle

```
draft     -> submitted | cancelled
submitted -> approved | rejected | draft (withdrawn)
rejected  -> submitted (resubmitted) | cancelled
approved  -> paid
paid, cancelled -> terminal
```

Editable in `draft` and `rejected` only. `approved` is a **409** because it has
hit the append-only ledger; `submitted` is a 409 because an approver is reading
it (withdraw first).

`rejected` is a resting, **editable** state rather than a terminal one. PRD-006:
*"Rejection returns the claim to the employee with a comment; resubmission
allowed."* Dropping it back to `draft` would satisfy that mechanically while
losing the reason it came back, which is the only thing the employee needs.
Resubmission creates a **new** `approvals` row and the rejected one stands
(SESSION-PLAN C8) — there is no `supersedes` column anywhere.

## The posting

On approval:

```
Dr {category.expense_account}   line.amount_cents   (one line per claim line)
Cr 2100 Employee Reimbursements Payable   -(total)
```

On reimbursement:

```
Dr 2100 Employee Reimbursements Payable   total
Cr 1000 Cash                             -(total)
```

Dimensions on every expense line: `employee_id`, `project_id` (line, else
claim), `department_code` (line, else claim, else **the employee's own
department** — an expense claim is the one case where the correct department is
never actually unknown). The payable leg carries `employee_id` only: it is a
balance-sheet account, so it never reaches the profitability rollup, and "who
are we out of pocket to" is the one question it needs to answer.

### Two legs, not three — the SST Input leg is not here

PRD-006 specifies `Dr {category expense} / Dr SST Input (if applicable) / Cr
Employee Reimbursements Payable`. `SST Input` belongs to PRD-001's tax work,
which is **S12** and lands after this session (SESSION-PLAN **C2**). This
session posts the two-leg entry and **does not invent an SST account**.

That is not a rounding-off of the requirement. For a tenant that is not
SST-registered the input tax is unrecoverable and genuinely *is* part of the
expense, so debiting the gross amount to the category account is the correct
entry rather than an approximation of one. `expense_claim_lines.tax_cents` is
captured on every line regardless.

**S12's change is precise:** in `posting.ts`, reduce each expense debit from
`amount_cents` to `amount_cents - tax_cents` and add one `Dr SST Input` line for
the summed tax. The credit leg does not move — the employee is still owed the
gross. Nothing else changes.

### Why postings are `source_type = 'manual'`

`journal_entries.source_type` carries `CHECK (source_type IN ('invoice',
'payment', 'manual', 'reversal'))`, and adding `'claim'` means altering that
CHECK — which SQLite can only do by rebuilding the table. That rebuild is not
available:

- `journal_lines` FK-references `journal_entries (tenant_id, entry_id)`, so
  `DROP TABLE journal_entries` raises `SQLITE_CONSTRAINT_FOREIGNKEY` on any
  database with rows in it.
- `0022_roles_drop_check.sql` already proved D1 will not defer that FK —
  `defer_foreign_keys`, `foreign_keys = off`, `legacy_alter_table` and
  `writable_schema` were all tried and none work. Its fix was to empty the
  referencing rows first.
- `journal_lines` cannot be emptied: `journal_lines_no_delete BEFORE DELETE …
  RAISE(ABORT)`. Getting past it means dropping the append-only triggers
  mid-migration.

So claim postings are `'manual'` with `source_id = clm_…` and a memo naming the
claim. Nothing is unqueryable — "every claim posting" is
`WHERE source_id LIKE 'clm_%'` and "this claim's entry" is one indexed lookup.
The cost is cosmetic: the ledger view labels a system-generated posting
"manual". **S12/S13 should spend one reviewed rebuild on the whole vocabulary**
(`claim`, `claim_payment`, `credit_note`) rather than each smuggling a trigger
drop into an unrelated session.

## Atomicity, and the one change to the approvals primitive

PRD-006's load-bearing criterion: *"the posting and the approval decision are
atomic (no approved claim without its entry)."*

No event consumer can deliver that. On the paid plan the queue consumer runs
after the decision has committed; on the free plan `src/queue/direct.ts` catches
a throwing consumer, logs it and **drops** it. Either way the decision is
already durable and there is nothing to roll back.

So S5 gave the approvals primitive a per-`subject_type` **decision effect**
(`src/modules/approvals/decision-effects.ts`), in the same shape as the
`SUBJECT_STRATEGIES` map it already had. `decide()` builds its `approvals`
UPDATE as a statement, asks the effect for more statements, and runs **one
`env.DB.batch([...])`** — which D1 executes as a single transaction, the same
mechanism `createInvoice` and `recordPayment` already use.

```ts
// src/modules/approvals/decision-effects.ts
export const SUBJECT_DECISION_EFFECTS: Partial<Record<SubjectType, DecisionEffect>> = {
  expense_claim: applyClaimDecision,
};
```

What this preserves:

- **No second approvals mechanism.** No module-local approval table, no
  module-local decision route; the console still calls
  `POST /v1/approvals/:id/approve`.
- **The hook is in the service, not the route**, so a programmatic `decide()`
  caller gets the same guarantee as a human clicking Approve.
- **An effect that throws writes nothing at all** — not the decision, not the
  claim, not the entry. The approval stays `pending` and the approver gets a
  4xx naming what to fix (via `isDecisionEffectError`, matched structurally so
  the primitive needs no import from a consuming module).

**S7's leave-balance deduction is the next one.** Add a line to that map plus one
function in the consuming module. The effect file must **not** import
`approvals/service` — the service imports the effect registry, so anything else
is a cycle. Today: `service.ts` → `decision-effects.ts` → `claims/decision.ts` →
`{claims/repo, claims/posting, schemas/envelope}`, while `claims/service.ts`
imports `service.ts`.

## Chart of accounts

- **`2100 Employee Reimbursements Payable`** joined `SYSTEM_ACCOUNTS`
  (`src/modules/finance/ledger.ts`), `is_system = 1`. Both legs of every claim
  posting reference it by code, which makes it ledger machinery. This changed the
  seeded chart, so `test/finance-ledger.test.ts` has two updated assertions.
- **`5100`–`5500`** (Travel, Meals & Entertainment, Accommodation, Office
  Supplies, Mileage) are seeded by the claims module with `is_system = 0`, so a
  tenant can rename, archive or re-map them. `other` maps to the existing
  `5000 General Expenses`.

Categories and their accounts are seeded lazily and idempotently by
`ensureClaimCategories`, called on every `GET /v1/claim-categories` and on claim
creation. There is no onboarding step to forget.

## HTTP surface

Both routers are mounted on the **`self`** capability module, not `people` or
`finance` — the same reasoning as `/v1/approvals`. The `employee` self-service
tier holds `self` and `meta` and nothing else, and employees are exactly who
files a claim; gating this on a business module would make the feature unusable
by its primary user.

Authorization is therefore **per row, never per role**. A caller may see a claim
if it is their own, *or* they are the approver on one of its approvals (a manager
routed a claim by the C1 upward walk may hold no finance capability at all and
cannot decide without seeing the receipt), *or* they hold `finance:read`.
Everything else is a **404, not a 403** — a 403 would confirm that a colleague
filed a claim.

**Reading and acting are separate questions**, and the reason is `readonly`: it
holds `finance:read` (a full business observer) *and* `self:write` (so an observer
who is also staff can file their own claim). A read-based check on the write paths
would therefore let an observer edit a colleague's claim. So `seesAllClaims` gates
reads on `finance:read`, and `managesAllClaims` gates acting-on-somebody-else's on
`finance:write` or `people:write`. Do not collapse them.

| Route | Notes |
|---|---|
| `GET /v1/claims` | `?status=&employee_id=&mine=true&awaiting_me=true`. Defaults to the caller's own claims for anyone without `finance:read`. |
| `POST /v1/claims` | Create a `draft` with lines. `Idempotency-Key` honoured. |
| `GET /v1/claims/:id` | Header + lines (category, GL account, receipt metadata) + `limit_warnings`. What the inbox card reads. |
| `PATCH /v1/claims/:id` | Header. `draft`/`rejected` only. |
| `PUT /v1/claims/:id/lines` | Replace the line set; recomputes the header totals in the same batch. |
| `POST /v1/claims/:id/submit` | Validates receipts, raises the approval, emits `claim.submitted`. Also the resubmission route. |
| `POST /v1/claims/:id/withdraw` | Cancels the pending approval, back to `draft`. |
| `POST /v1/claims/:id/cancel` | `draft`/`rejected` → `cancelled`. |
| `POST /v1/claims/:id/reimburse` | **`finance:write`.** Posts Dr payable / Cr cash, marks `paid`, emits `claim.paid`. `Idempotency-Key` honoured. |
| `POST /v1/claims/receipts` | Multipart upload, purpose **forced** to `claim_receipt`. |
| `GET /v1/claims/:id/lines/:n/receipt` | Streams the receipt. |
| `GET`/`POST`/`PATCH` `/v1/claim-categories` | Reads open to any login (it is the filer's picklist); writes **`finance:write`**, because mapping a category to a GL account is a chart-of-accounts act. |

### Why receipts have their own two routes

`/v1/files` is gated on `files:write` and `files:read`, and the `employee` tier
holds neither. The alternatives were widening `employee` to the files module —
which would let them upload a tenant logo or a signature, neither of which is
theirs to touch — or these two purpose-locked routes.

Both still go through the files primitive (`uploadFile`, `getFile`,
`readFileBody`), never R2, so the per-purpose policy, the tenant-scoped object
key and the SHA-256 all apply unchanged. `purpose` is not a form field on the
upload route, so it cannot write any other kind of file. On the read route,
**authorization follows the claim**: whoever may see the claim may see its
receipts, which is the correct boundary and the only one that works when neither
the filer nor the approver holds a files capability. The response is built by the
same exported `streamFile` the `/v1/files` route uses, so headers, ETag and
hostile-filename handling are identical.

## Events

`claim.submitted`, `claim.approved`, `claim.rejected`, `claim.paid` — registered
in `src/schemas/events/registry.ts`, `source_module = people`.

**None of them is mapped in the notification consumer, on purpose.** The
`approval.*` events already tell the approver a decision is needed and the
employee what was decided; adding `claim.*` mappers would put two rows in the
same bell for one submission. PRD-006's "the manager has a notification" and "the
employee is notified" are satisfied by S3's events and S4's consumer with no
change to either. These four exist for the audit log and for the PeopleAgent
PRD-006 designs for.

`claim.approved` and `claim.paid` both carry `entry_id`, and it is guaranteed to
resolve: the event is emitted after the batch that wrote both the status and the
entry.

## Console

- **`ui/src/features/approvals/renderers/ExpenseClaimCard.tsx`**, registered as
  `expense_claim` in the renderer registry. Receipt inline and zoomable,
  category, amount, project, department, limit status, per-line breakdown, and
  the GL account each line will debit — so an approver can catch a
  mis-categorised claim before it reaches the books.
- **`ui/src/pages/claims/ClaimDetail.tsx`** — read-only, at `/claims/:id`. It
  exists because `subjectRoutes.ts` now maps `expense_claim` here; filing and
  editing from the console are PRD-006 **P1**.
- **Receipts are fetched, not `<img src>`-ed.** The session cookie is
  `SameSite=Lax`, which excludes cross-origin subresource requests, and the
  console and API are separate origins in every deployment — so a bare `src`
  would send no credential and 401. `ApiClient.getBlob()` fetches with
  `credentials: 'include'` and the component renders an object URL, revoked on
  unmount. A PDF receipt is offered as a link instead, since it cannot render in
  an `<img>`.

## Things that will bite

- **Mileage amounts are stored, not derived.** `distance_km ×
  per_km_rate_cents`, rounded, written to the row. Editing a category's rate next
  year must not restate a claim that has already been agreed, let alone posted.
- **Line amounts are gross.** `tax_cents` is part of `amount_cents`, not on top
  of it. A line whose tax exceeds its amount is a 422.
- **A project id that names nothing is worse than none.** PRD-001a's rollup falls
  back to the raw id for a project it cannot resolve, so a typo would appear as a
  phantom bucket beside the real ones. Both `project_id` and `department_code`
  are validated on write.
- **Limits warn, they never block.** A hard limit would have an employee quietly
  not claiming money they are owed. Scope is per claim, per category — a
  calendar-window limit needs a period vocabulary and an answer to "which month
  does a backdated receipt count against", and a `limit_period` column is
  additive.
- **Submit re-validates the lines.** A receipt can be deleted, a category
  archived or a project removed between drafting and submitting, and PRD-006's
  "a claim without a receipt is rejected" has to hold at the moment somebody is
  asked to decide.
- **An archived category account fails at approval, loudly.** Finance tidying the
  chart while a claim sits pending is the realistic failure. The approver gets a
  422 naming the account, the approval stays `pending`, and nothing is written —
  which is the atomicity guarantee working, not breaking.
- **Test harness:** the Workers test env has a real EVENTS queue binding and the
  runtime delivers those messages *after* the request that sent them — i.e. after
  the `it`. The consumer touches D1, which breaks isolated-storage teardown with
  "Failed to pop isolated storage stack frame". `test/claims-fixture.ts` hands the
  Worker an env whose EVENTS is a recording sink for exactly this reason. Any
  suite that ends on an approval will need the same.
