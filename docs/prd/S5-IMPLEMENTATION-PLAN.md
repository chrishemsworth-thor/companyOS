# S5 — PRD-006a: Expense claims + GL posting — implementation plan

**Branch:** `claude/claims-submission-approval-posting-gaa3oz` ·
**Depends on:** S1 (ledger dimensions), S2 (files), S3 (approvals), S4 (notifications + inbox)

Read first: SESSION-PLAN **C2** (SST Input leg out of scope), **C8** (resubmission
creates a new approval row), standing rules 1–6.

**Measured baseline on this branch** (standing rule 4 — the number in SESSION-PLAN
is stale, as it warns it would be): clean typecheck, **45 test files / 749 tests**
in the Workers suite, **12 files / 92 tests** in `ui/`. SESSION-PLAN records 42/476
and 12/88 after S4; `main` has moved since. Nothing may drop below the measured
numbers.

**Next migration number:** `0024`. `0023_notifications.sql` is the highest on
`main` (`0015` is already doubled; no third collision added).

---

## 0. What is already in place (verified against this branch)

Four things the brief implies are new but are not, so the plan does not re-add them:

| Thing | State |
|---|---|
| `subject_type = expense_claim` | **Already in `subjectTypeSchema`** (S3 reserved it) and already mapped to `manager_chain` in `SUBJECT_STRATEGIES`. Nothing to add — S3 built the extension point and used it. |
| `purpose = claim_receipt` | **Already in `FILE_PURPOSES`** with the default policy (10 MB; png/jpeg/webp/pdf; not publicly readable). No policy change. |
| Notifications for claim approval | **Already covered** by `approval.requested` / `approval.approved` / `approval.rejected` in `NOTIFICATION_MAP`. PRD-006's "the manager has a notification" and "the employee is notified" are satisfied by the S3 events. **No `NOTIFICATION_MAP` entries for `claim.*`** — a second notification per decision would double the badge. |
| Ledger dimensions | `journal_lines` already carries `employee_id`, `project_id`, `department_code`. Nothing to migrate. |

So the new surface is: the claims tables, the claim service, the posting, the
GL-account seeding, four events, the HTTP routes, and the inbox card.

---

## 1. The atomicity problem, and the one change to the approvals primitive

The load-bearing acceptance criterion is:

> Given claim approval, then the posting and the approval decision are atomic
> (no approved claim without its entry).

Today `decide()` in `src/modules/approvals/service.ts` runs the `approvals`
UPDATE with `.run()` and then emits `approval.approved`. Every way of hanging
the posting off that event breaks the criterion: on the paid plan the queue
consumer runs after the decision has committed, and on the free plan
`src/queue/direct.ts` catches and **drops** a throwing consumer. Either way a
decision can exist with no journal entry, and there is nothing to roll back.

**Change:** give the approvals primitive a per-`subject_type` **decision-effect**
hook, in the same shape as the `SUBJECT_STRATEGIES` map it already has.

- `src/modules/approvals/decision-effects.ts` — `SUBJECT_DECISION_EFFECTS:
  Partial<Record<SubjectType, DecisionEffect>>`. A `DecisionEffect` is
  `(env, tenantId, approval, decision, decidedAt) => Promise<{ statements:
  D1PreparedStatement[]; events: EventEnvelope[] }>`.
- `decide()` builds its own UPDATE as a statement rather than running it, calls
  the effect for the row's subject type, and runs **one `env.DB.batch([...])`** —
  D1 batches are a single transaction, which is the same mechanism
  `createInvoice` and `recordPayment` already use to post a journal entry
  atomically with their own rows. Then it emits the `approval.*` event plus the
  effect's events.
- An effect that throws leaves the approval **pending** and writes nothing. That
  is the criterion in both directions: no approved claim without its entry, and
  no entry without the approval.

This is an extension point on the primitive, not a second approvals mechanism:
no new table, no module-local approval state machine, and the console keeps
using `POST /v1/approvals/:id/approve`. A programmatic `decide()` caller gets the
posting too, which is why the hook belongs in the service and not in the route.

**No import cycle:** `approvals/service.ts` → `approvals/decision-effects.ts` →
`claims/decision.ts` → `{claims/repo.ts, finance/ledger.ts, schemas/envelope.ts}`.
`claims/service.ts` → `approvals/service.ts`. `claims/decision.ts` deliberately
does not import anything from `approvals/`.

---

## 2. D1 migration — `0024_expense_claims.sql`

`0023_notifications.sql` is the highest on `main`, so this session takes **0024**
(standing rule 5; `0015` is already doubled, no third collision added).

### `claim_categories`

Per tenant, each mapped to a GL expense account — the mapping is what makes
posting possible.

```
tenant_id, category_id (ccat_...), code, name,
expense_account_id  -> accounts(tenant_id, account_id)   NOT NULL
kind                'standard' | 'mileage'   CHECK
per_km_rate_cents   INTEGER   -- required when kind='mileage', else NULL
limit_cents         INTEGER   -- NULL = no limit
archived_at
PRIMARY KEY (tenant_id, category_id)
UNIQUE (tenant_id, code)
```

- `limit_cents` is a **per-claim, per-category** cap: the sum of one claim's
  lines in that category. Deliberate: a calendar-window limit needs a period
  vocabulary and a "which month does a backdated receipt count against" answer,
  and PRD-006 asks only for "a warning on breach". A period column is additive.
- Seeded defaults, all editable: `mileage`, `meals`, `travel`, `accommodation`,
  `supplies`, `other` — PRD-006's own list.

### `expense_claims`

```
claim_id (clm_...), tenant_id, employee_id -> employees,
claim_date (YYYY-MM-DD), description, currency,
total_cents  -- = SUM(lines.amount_cents), maintained by the service
tax_cents    -- = SUM(lines.tax_cents); RECORDED, NOT POSTED (C2)
status       'draft' | 'submitted' | 'approved' | 'rejected' | 'paid' | 'cancelled'  CHECK
project_id, department_code            -- claim-level dimension defaults
submitted_by -> users, submitted_at,
approval_id                            -- the live/last approval row, soft reference
rejection_comment, rejected_at,
entry_id                               -- the approval posting; NULL until approved
paid_entry_id, payment_reference, paid_at,
created_at, updated_at
PRIMARY KEY (tenant_id, claim_id)
```

Lifecycle, in one table so it is auditable at a glance (the same shape as
`src/modules/support/state-machine.ts`, whose 409 convention this matches):

```
draft     -> submitted | cancelled
submitted -> approved | rejected | draft (withdraw)
rejected  -> submitted (resubmit, NEW approval row per C8) | cancelled
approved  -> paid
paid      -> (terminal)
cancelled -> (terminal)
```

Editable (`PATCH`, line replacement) only in `draft` and `rejected`. **`approved`,
`paid` and `submitted` all 409** — `approved` because it has hit the ledger
(PRD-006's criterion), `submitted` because an approver is looking at it.

`rejected` is a resting, editable state rather than a terminal one: PRD-006 says
rejection "returns the claim to the employee with a comment; resubmission
allowed", and a user needs to see *why* it came back rather than find it silently
in drafts.

### `expense_claim_lines`

```
tenant_id, claim_id, line_no, category_id -> claim_categories,
description,
distance_km REAL          -- mileage only; NULL otherwise
amount_cents INTEGER NOT NULL CHECK (amount_cents > 0)
tax_cents    INTEGER NOT NULL DEFAULT 0
receipt_file_id -> files   NOT NULL          -- PRD-006: receipt required
project_id, department_code                  -- override the claim-level default
PRIMARY KEY (tenant_id, claim_id, line_no)
```

- **Receipt is required per line, not per claim.** PRD-006 wants "one submission,
  several receipts", so the receipt belongs to the line that has a receipt.
  "A claim without a receipt is rejected" then falls out of the line constraint
  plus "a claim needs at least one line" in the service.
- Mileage: `amount_cents = round(distance_km × category.per_km_rate_cents)`,
  computed in the service and **stored**, so a later rate change does not
  retroactively alter a posted claim.
- `tax_cents` is stored per line and summed on the header. **It is not posted**
  — see C2 and §4.

Indexes: `(tenant_id, employee_id, status, claim_id)` (an employee's own claims),
`(tenant_id, status, claim_id)` (the unpaid-liability read), `(tenant_id, project_id)`.

### Chart of accounts

`SYSTEM_ACCOUNTS` in `src/modules/finance/ledger.ts` gains **one** row, as the
brief specifies:

- `2100 Employee Reimbursements Payable` (liability), `is_system = 1`.

The five default category expense accounts are seeded by the **claims module**
alongside the default categories (`is_system = 0`, so a tenant can rename or
re-map them): `5100 Travel`, `5200 Meals & Entertainment`,
`5300 Accommodation`, `5400 Office Supplies`, `5500 Mileage`. `other` maps to the
existing `5000 General Expenses`.

> **Regression-net note.** `test/finance-ledger.test.ts` asserts the seeded chart
> is exactly `["1000","1100","2000","3000","4000","5000"]` and has length 6. S1's
> brief called that file a net that must pass *unmodified*. Adding `2100` breaks
> those two assertions, so **this session updates them** — a deliberate change to
> the seeded chart the brief asks for, not a behavioural regression. Every other
> assertion in that file stays untouched, as do
> `test/ledger-entries.test.ts`, `test/finance-lifecycle.test.ts`,
> `test/finance-service.test.ts` and `test/ledger-dimensions.test.ts`.

---

## 3. Module layout

```
src/modules/claims/
  types.ts       -- vocabulary + row shapes, dependency-free
  categories.ts  -- seeding + CRUD for claim_categories and their GL accounts
  repo.ts        -- tenant-scoped reads of claims/lines (no approvals import)
  posting.ts     -- buildClaimPostingStatements(): the two-leg entry
  decision.ts    -- the DecisionEffect: approve -> post + mark approved; reject -> mark rejected
  service.ts     -- create/patch/lines/submit/withdraw/cancel/reimburse
```

`ClaimsError(code, message, httpStatus: 400|403|404|409|422)`, mirroring
`SupportError` / `ApprovalsError` / `FilesError`.

---

## 4. The posting

**On approval** (inside the approval decision's batch):

```
Dr  {category.expense_account_id}   line.amount_cents   -- one line per claim line
Cr  2100 Employee Reimbursements Payable   -(total)     -- one line
```

- Dimensions on every expense line: `employee_id` (the claim's employee),
  `project_id` (line ?? claim), `department_code` (line ?? claim ?? the
  employee's `department_id`).
- The payable leg carries `employee_id` only. It is a balance-sheet account, so
  it never reaches the profitability rollup (which filters
  `a.type IN ('revenue','expense')`), and "who are we out of pocket to" is the
  one question it needs to answer.
- `source_type = 'manual'`, `source_id = clm_…`, memo `expense claim clm_… approved`.
  **Not** a new `'claim'` source type — see §9.1; this is a resolved decision, not
  an open one, and the migration comment records why.
- **Two legs only. No SST Input leg, and no SST account invented (C2).** The
  expense debit is the **gross** line amount — which is the accounting-correct
  treatment for a tenant that is not SST-registered, since unrecoverable input
  tax *is* part of the expense. `tax_cents` is captured on the line so S12 has
  the number it needs, and `posting.ts` carries a comment naming S12 as the
  session that adds `Dr SST Input` and reduces the expense debit to net.

**On reimbursement** (`POST /v1/claims/:id/reimburse`, one batch):

```
Dr  2100 Employee Reimbursements Payable   total
Cr  1000 Cash                             -(total)
```

status → `paid`, `paid_entry_id` / `paid_at` / `payment_reference` stamped, emit
`claim.paid`. Only from `approved`; anything else 409s.

**Liability + cash-flow outlook:** the payable balance is already queryable via
the existing `accountBalance` / ledger endpoints. For PRD-006's "unpaid approved
claims appear as a liability and in the cash-flow outlook", `dashboardSummary`
gains an `unpaid_claims: { count, by_currency }` bucket, alongside the existing
four KPIs. (Adding a key; the existing `test/insights.test.ts` assertions are
per-key and unaffected.)

---

## 5. Endpoints

Two new routers in the `V1_MOUNTS` table in `src/index.ts`.

### `/v1/claims` — capability module **`self`**

On the identity axis, for the same reason `/v1/approvals` is: the `employee`
tier holds `self` and nothing else, and employees are exactly the people filing
claims. Authorization is **per row** in the service, never per role. A caller may
read a claim if any of:

1. it is their own (their `employees.user_id` link), or
2. they are the `approver_user_id` on its approval row — a manager may hold no
   finance capability and still has to see the receipt before deciding, or
3. they hold `finance:read` (finance/operator/admin/readonly see all).

| Method & path | Notes |
|---|---|
| `GET /v1/claims` | `?status=&employee_id=&mine=true`, cursor-paginated on the ULID. Scoped by the rule above. |
| `POST /v1/claims` | Create a `draft` with its lines. `withIdempotency`, matching invoices/payments. |
| `GET /v1/claims/:id` | Header + lines (with category name, GL account code, receipt file id/metadata) + `limit_warnings` + `approval` + `entry_id`. This is what the inbox card reads. |
| `PATCH /v1/claims/:id` | Header fields. `draft`/`rejected` only; **409 otherwise, including `approved`**. |
| `PUT /v1/claims/:id/lines` | Replace the line set wholesale. Same state gate. Simpler and more atomic than per-line CRUD. |
| `POST /v1/claims/:id/submit` | Validates ≥1 line and a receipt on every line, recomputes totals, then **one batch**: status → `submitted` + `requestApproval()`. Emits `claim.submitted`. Response carries `limit_warnings` — over-limit **warns and still submits**. |
| `POST /v1/claims/:id/withdraw` | `cancelForSubject()` on the pending approval, status → `draft`. Requester or admin. |
| `POST /v1/claims/:id/cancel` | `draft`/`rejected` → `cancelled`. |
| `POST /v1/claims/:id/reimburse` | `requireCapability("finance:write")`. `approved` → `paid` + the Dr payable / Cr cash entry, in one batch. `withIdempotency`. |

Note `submit` requests the approval with `subject_employee_id` set to the claim's
employee, so a claim filed **on behalf of** someone routes to *that* employee's
manager — the exact case `RequestApprovalInput.subject_employee_id` was built
for in S3.

### `/v1/claim-categories` — capability module **`self`**, writes gated `finance:write`

Reads are a picklist every filer needs (an `employee` login must be able to
choose "meals"), so the router sits on the identity axis and `POST`/`PATCH`
carry `requireCapability("finance:write")` — mapping a category to a GL account
is a chart-of-accounts act, not an HR one. Same shape as `/v1/people`'s
`requireCapability("admin:write")` on the invite route.

| Method & path | Notes |
|---|---|
| `GET /v1/claim-categories` | Seeds the tenant's defaults on first read, then lists (idempotent, `INSERT OR IGNORE`). |
| `POST /v1/claim-categories` | name, code, `expense_account_id`, kind, `per_km_rate_cents`, `limit_cents`. Validates the account exists, is `type = 'expense'`, and belongs to the tenant. |
| `PATCH /v1/claim-categories/:id` | Rename, re-map the account, change the limit/rate, archive. Does **not** retro-alter posted claims. |

---

## 6. Events to register

Four new files under `src/schemas/events/`, four lines in
`src/schemas/events/registry.ts`. Wire types are unversioned per the existing
convention; `source_module` is **`people`** (claims are a People-module concern —
`platform` is reserved for primitives belonging to no module).

| Wire type | Schema file | Payload |
|---|---|---|
| `claim.submitted` | `claim.submitted.v1.ts` | claim_id, employee_id, submitted_by, total_cents, tax_cents, currency, claim_date, line_count, project_id, department_code, approval_id, over_limit (bool) |
| `claim.approved` | `claim.approved.v1.ts` | claim_id, employee_id, approval_id, decided_by, decided_at, total_cents, currency, **entry_id** |
| `claim.rejected` | `claim.rejected.v1.ts` | claim_id, employee_id, approval_id, decided_by, decided_at, comment? |
| `claim.paid` | `claim.paid.v1.ts` | claim_id, employee_id, total_cents, currency, paid_at, entry_id, payment_reference? |

No `AGENT_ROUTES` entries (no agent consumes these in v1) and no
`NOTIFICATION_MAP` entries (see §0).

---

## 7. Console — the claim card only

`ui/src/features/approvals/renderers/ExpenseClaimCard.tsx`, registered as
`expense_claim` in `renderers/registry.ts`, plus one line in
`ui/src/lib/subjectRoutes.ts`.

Shows, per the brief: category, amount (per line and header total), project,
department, **limit status**, the line breakdown, and the **receipt image inline
and zoomable**. Loads `GET /v1/claims/:id` with react-query, keyed on
`approval.subject_id`.

- **Receipt fetch.** The session cookie is `SameSite=Lax`, so a cross-origin
  `<img src="…/v1/files/:id">` would send no credential and 401. So the card
  fetches the bytes through the API client and renders an object URL. That needs
  a small `ApiClient.getBlob(path)` (the client currently always parses JSON) —
  revoking the URL on unmount.
- **Zoom** = tap/click the thumbnail → full-screen overlay, Escape/backdrop to
  close, reusing `ui/src/components/Modal.tsx`'s focus-trap conventions. PRD-007's
  mobile criterion is "images tappable to full screen", so the thumbnail is a
  ≥40px-target `<button>`, not an `<img onClick>`.
- Degrades honestly: a claim the caller cannot read (403) or a missing receipt
  renders a stated fallback rather than a broken image — the renderer must never
  crash the inbox shell.

**No claims console page in this session.** PRD-006 puts "employee self-service
view of their own leave and claim history as a standalone page" in **P1**, and the
brief's deliverable is the renderer. So `subjectRoutes` gets the `expense_claim`
line only once there is a screen to point at — see §9.2.

---

## 8. Tests

Every acceptance criterion gets a test in the Workers runtime suite. Isolated
storage is on, so shared fixtures (tenants, users, employees + reporting lines,
categories) are seeded in `beforeAll`; claims are created per `it`.

### `test/claims.test.ts` — PRD-006 § "Claims: submission" (4 criteria)

| Criterion | Test |
|---|---|
| A claim without a receipt is rejected | submit with a receipt-less line → 400, status stays `draft`, no approval row |
| A JPEG receipt uploads and displays in the approval view | upload via `POST /v1/files` (`purpose=claim_receipt`), attach, submit; `GET /v1/claims/:id` **as the resolved approver** returns the receipt metadata and `GET /v1/files/:id` streams the JPEG |
| Multi-line claim: header total = sum of lines | 3 lines → `total_cents` equals the sum; and again after a line is replaced |
| Over-limit category warns and still submits | limit 20000, lines totalling 25000 → 201/200 with `limit_warnings` naming the category and both numbers, `status = submitted` |

Plus: mileage `distance_km × per_km_rate_cents` (stored, and unchanged by a later
rate edit); `department_code` defaulting from the employee; tenant B cannot read
tenant A's claim (404); an employee cannot read a colleague's claim (404) but
finance can; a claim filed on behalf of another employee routes to *their*
manager; `claim.submitted` validates against the registry.

### `test/claims-posting.test.ts` — PRD-006 § "approval and GL posting" (6 criteria)

| Criterion | Test |
|---|---|
| Approved RM250 meals claim → balanced entry to the meals expense account and reimbursements payable | approve via `POST /v1/approvals/:id/approve`; assert two lines, `+25000` on the `5200` account, `-25000` on `2100`, lines sum to 0, `employee_id` on the expense line |
| Claim tagged to project P → expense line carries `project_id = P` and appears in P's profitability | assert the line dimension **and** `GET /v1/insights/profitability?group_by=project` moves P's `cost_cents` by the claim amount |
| Reimbursement clears the payable and the claim is `paid` | `POST /:id/reimburse` → `accountBalance(2100)` back to 0, `status = paid`, `paid_entry_id` set, `claim.paid` emitted |
| A rejected claim has no ledger entry | reject → `status = rejected`, `entry_id` NULL, zero `journal_entries` with that source, rejection comment on the claim |
| An approved claim, when edited, is a 409 | `PATCH` and `PUT …/lines` on an `approved` claim → 409 naming the state; also on `paid` |
| **The posting and the decision are atomic** | see below |

**The atomicity test**, two directions:

1. *No approved claim without its entry.* Break the effect after submission — the
   category's expense account is archived/removed so `buildClaimPostingStatements`
   throws `unknown_account` — then approve. Assert: 4xx/5xx to the approver, the
   approval row is **still `pending`**, the claim is **still `submitted`**,
   `entry_id` is NULL, and `journal_entries` has no new row.
2. *No entry without the approved claim.* Happy path: after one approve call,
   exactly one entry exists, `approvals.state = 'approved'` and
   `expense_claims.status = 'approved'` both hold, and a **second** approve is a
   409 that posts nothing (assert the entry count is unchanged) — so a retry
   cannot double-post to the ledger.

Plus: `approval.approved` and `claim.approved` are both emitted and both validate;
resubmission after rejection creates a **new** approval row with the old one
still `rejected` (C8); the tax amount is recorded on the line and **no third leg
and no SST account exists** (a positive assertion for C2: exactly two legs, and
no account whose code/name mentions SST).

### `test/claim-categories.test.ts`

Defaults seeded once and idempotently; every default maps to an existing
`type = 'expense'` account in the tenant; `2100` is in the seeded chart;
`POST` with a revenue account → 422; `POST` with another tenant's account id →
422; a non-finance login gets 403 on write and 200 on read; an `employee` login
can read the picklist; archiving a category leaves posted claims intact.

### Console — `cd ui && npm test`

- `ui/src/features/approvals/renderers/ExpenseClaimCard.test.tsx` — renders
  category/amount/project/limit status/line breakdown; the receipt thumbnail is a
  button that opens a full-screen view and Escape closes it; a 403 on the claim
  and a missing receipt each render a stated fallback rather than throwing.
- `renderers/registry.test.tsx` — **update**: `expense_claim` now resolves to
  `ExpenseClaimCard`, `registeredSubjectTypes()` is `["expense_claim"]`, and the
  "fallback for every type S4 knows about" case narrows to the four types that
  still have no card. The unknown-type fallback assertions stay.
- `ui/src/api/client.test.ts` — `getBlob` sends credentials and throws `ApiError`
  on a non-2xx.
- `ui/src/lib/subjectRoutes.test.ts` — touched only if §9 adds the route.

### Files changed outside new code

`test/finance-ledger.test.ts` (two seeded-chart assertions — see §2),
`renderers/registry.test.tsx`, and `docs/prd/SESSION-PLAN.md` (status column,
next migration number, new baseline, an S5 "Shipped" note).
New: `docs/modules/claims.md`, matching `docs/modules/{files,approvals,notifications}.md`.

---

## 9. Two things I want to name rather than bury

### 9.1 Claim postings use `source_type = 'manual'`, and that is the least-bad option

`'claim'` / `'claim_payment'` would read better in `GET /v1/ledger/entries`, and I
am not proposing them, because adding them means extending a SQL CHECK on
`journal_entries` — which SQLite can only do by rebuilding the table. On this
schema that rebuild is not available:

- `journal_lines` FK-references `journal_entries (tenant_id, entry_id)`, so
  `DROP TABLE journal_entries` raises `SQLITE_CONSTRAINT_FOREIGNKEY` on any
  database with rows in it.
- The 0022 rebuild proved D1 will not defer that: `PRAGMA defer_foreign_keys`,
  `foreign_keys = off`, `legacy_alter_table` and `writable_schema` were all tried
  and none work. Its fix was to empty the referencing rows first.
- `journal_lines` cannot be emptied. It carries
  `journal_lines_no_delete BEFORE DELETE … RAISE(ABORT)`. Getting past that means
  dropping the append-only triggers mid-migration, which is exactly what standing
  rule 1 forbids.

So: `'manual'` with `source_id = clm_…` and a memo naming the claim. `source_id`
already carries a typed prefix, so "every claim posting" is
`WHERE source_id LIKE 'clm_%'` and "this claim's entry" is one indexed lookup —
nothing is actually unqueryable. **Flagging it because the ledger UI will label a
system-generated posting "manual", which is user-visible and slightly wrong.** The
right place to fix it is S12 or S13, which touch finance anyway and can spend the
rebuild once for the whole vocabulary (`claim`, `claim_payment`, `credit_note`) —
with the trigger drop/recreate reviewed as its own change rather than smuggled in
here. Tell me if you would rather I spend it now instead.

### 9.2 No `subjectRoutes` entry, because there is no screen to point at

The brief asks for the card; PRD-006 puts the standalone claim-history page in
**P1**. A route to a page that does not exist sends the user to the catch-all
redirect, which is worse than the honest "this build has no detailed view" the
generic card already prints. **Proposal: leave `ui/src/lib/subjectRoutes.ts`
untouched this session.** The card carries the full context inline — receipt,
lines, limits, project — so nothing is lost by not deep-linking. Say the word if
you want a minimal read-only `/claims/:id` screen instead; it is one page, one
route line and one more test file, but it is P1 scope by PRD-006's own phasing.

## 10. Explicitly out of scope

The SST Input leg (C2 — S12 adds it), batch reimbursement runs, OCR pre-fill,
multi-step manager→finance approval, the standalone employee claim-history page,
a claims console list page, and anything in PRD-006's leave sections (S6/S7).
