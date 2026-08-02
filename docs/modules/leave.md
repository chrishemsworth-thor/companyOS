# Leave

The whole of PRD-006's leave story, built across two sessions and reconciled
into one module. `source_module: people`.

| Half | Session | Migration | Owns |
|---|---|---|---|
| **Policy** | S6 (PRD-006b) | `0025_leave_policy.sql` | leave types, entitlement policies, tenure bands, accrual, pro-rating, carry-forward, public holidays, work weeks |
| **Requests** | S7 (PRD-006c) | `0026_leave_requests.sql` | submission, approval routing, cancellation, the team calendar, `leave.*` events, the approvals-inbox renderer |

**Depends on:** the approvals primitive ([`approvals.md`](approvals.md)),
notifications ([`notifications.md`](notifications.md)), files
([`files.md`](files.md)), People ([`people.md`](people.md)).

The seam between the two halves is PRD-006's own balance formula:

```
available = entitlement + carry_forward − taken − pending
            └────── S6 owns ──────────┘   └── S7 owns ──┘
```

Both halves are now merged and wired to each other. If you are here because
something about entitlement looks wrong, read
[Where the two halves meet](#where-the-two-halves-meet) first — it is the only
place either half knows the other exists.

---

# Where the two halves meet

S6 and S7 were built concurrently from the same `main`, so S7 was written
against a branch where none of S6's tables existed. It shipped a deliberate
seam — `src/modules/people/leave/policy-port.ts` — as
`try { read S6 } catch { provisional default }`, with a header saying its
queries were "a best guess at PRD-006's wording, not a contract S6 agreed to"
and that they were to be corrected on merge.

They have been. **The port now calls S6's own functions rather than querying its
tables**, and the fallbacks are reached only on a database that has not run
`0025`. Every guess it shipped with turned out to be wrong, which is worth
recording because each one failed in a way that still typechecked:

| The port guessed | S6 actually has | Why the guess was silent |
|---|---|---|
| `leave_types.paid`, `.allows_negative_balance` | `is_paid`, `allow_negative_balance` | D1 raises at runtime, and the catch turned it into a fallback |
| a `leave_balances` table with a computed row per employee/type/year | no such table — entitlement is derived by `getBalances()` | same |
| a `leave_work_weeks` table holding `"1,2,3,4,5"` | `leave_settings.work_week`, a seven-fraction JSON array, overridable per employee | same |
| `public_holidays` filtered on `employees.location` | `employee_leave_profiles.work_state`, plus an `observed` flag for suppressions | a query that returns the wrong rows raises nothing at all |

Calling S6's functions rather than re-querying its tables is what gets the
module the things a raw `SELECT` would have quietly skipped: lazily seeded
defaults for a tenant that has never opened a leave screen, the merge of the
shipped national holiday calendar with tenant additions, `observed = 0`
suppressions, and the flag marking a year whose lunar and Islamic dates are
still projections.

**The suite logs no `[leave/policy-port]` warnings.** That is the check —
if one appears, a query has drifted back out of sync, and the fix is the
query, never a wider catch.

## `unconfigured` is not zero

The one piece of semantics that needed a deliberate decision rather than a
column rename. S6 distinguishes "configured, and the answer is zero" from
"nothing is configured for this type", in its own words:

> the balance is zero because nothing is configured, which is a different thing
> from a zero balance

Taken at face value, the second case blocks every request as over-balance —
a freshly seeded tenant has the seven leave types but no policies attached to
them yet, so every employee reads as having zero days of everything. So a
balance S6 marks `unconfigured` routes to the provisional entitlement and is
flagged `source: "default"`, which carries out through the API to the console
as "leave policy is not configured". A tenant with real policy gets
`source: "policy"` and the real number.

## One table, two type columns

`leave_requests` carries both `leave_type_code` and `leave_type_id`, and this is
load-bearing rather than redundant.

S6's `0025` created the table keyed on `leave_type_id` — it needed the
consumption side to test "a pending request reduces available balance
immediately" — and said S7 would add its columns additively. S7, unable to
reference a table that did not exist on its branch, keyed on the tenant-scoped
`leave_type_code` so the two migrations could land in either order.

Both survive. `leave_type_code` is the write path; `leave_type_id` is resolved
against `leave_types` at submission and stored alongside, because **S6's balance
engine groups consumption by `leave_type_id`**. Drop it and every entitlement
reads as fully available no matter how much leave has been booked. It is
nullable for the one honest case: a tenant with no configured types, where there
is no row to point at.

`0026` is therefore a table *rebuild* rather than a series of `ALTER TABLE ADD
COLUMN`. SQLite cannot widen a `CHECK` in place and `state` had to grow
`cancellation_pending`. The rebuild carries every existing row across and is
safe on a populated database.

---

# Part one — policy, entitlement and holidays (S6)

## The two decisions that shape this module

### 1. Public holidays ship as a data file, and the table holds only deltas

The SESSION-PLAN blocking decision for S6 was *"shipped data file — state
variation makes manual seeding per tenant an annual support burden."* The
implementation goes one step further than the decision required: the shipped
calendar is **never written to the database**.

```
effective holidays = shipped(year, scope) ∪ tenant additions − tenant suppressions
```

`public_holidays` rows are the tenant's deltas and nothing else. `observed = 1`
adds or renames a holiday, `observed = 0` suppresses a shipped one, and the
merge happens at read time in `holidays/resolve.ts`.

The alternative — copying the shipped rows into every tenant on first use, the
way `ensureSystemAccounts` seeds the chart of accounts — was rejected for two
reasons. It would make each year's update a backfill across every tenant rather
than a deploy; and once a tenant had edited a shipped row in place, "did we ship
it that way, or did they change it?" would have no answer.

Everything is keyed on **date + scope**, never date alone. A Selangor employee
and a Sarawak employee can have a holiday on the same date for different
reasons, and suppressing one must not remove the other.

### 2. Employment Act minimums warn, they never block

PRD-006: *"Employment Act minimums are a seed default and a warning, not an
enforced floor — a tenant may have contractual terms above minimum and the
system must not fight them."*

No CHECK constraint, no service-side rejection, nothing in the route layer can
refuse an entitlement for being below the statutory minimum. A policy write
returns **201/200 with the policy saved as entered**, plus a `warnings` array:

```jsonc
POST /v1/people/leave/policies
{ "leave_type_id": "lvt_…", "name": "Probation", "bands": [{ "entitlement_days": 5 }] }

201 {
  "policy": { …, "bands": [{ "entitlement_days": 5, … }] },
  "warnings": [{
    "code": "below_statutory_minimum",
    "basis": "annual",
    "entitlement_days": 5,
    "statutory_minimum_days": 8,
    "message": "5 days for all employment types at 0-24 months' service is below the
                Employment Act 1955 minimum of 8 days. Saved as entered — this is a
                warning, not a limit."
  }]
}
```

Below-minimum terms are legitimate in practice (probation bands, roles outside
the Act, non-EA contracts), so an enforced floor would be wrong even before the
PRD's instruction. The tables the warnings come from are served at
`GET /v1/people/leave/statutory-minimums` so a console can show the minimum next
to the field.

## Data model (`migrations/0025_leave_policy.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `leave_settings` | one row per tenant | `work_week` (JSON, 7 fractions), `defaults_seeded_at` |
| `leave_types` | what kinds of leave exist | `leave_type_id` (`lvt_`), `code` (unique per tenant), `is_paid`, `requires_attachment`, `max_consecutive_days`, `allows_half_day`, `carry_forward_allowed`, `allow_negative_balance`, `statutory_basis`, `archived_at` |
| `leave_policies` | how much, accrued how | `policy_id` (`lvp_`), `leave_type_id`, `accrual_method`, `carry_forward_max_days`, `carry_forward_expiry_months`, `is_default` |
| `leave_policy_bands` | entitlement by type + tenure | `band_id` (`lvb_`), `employment_type` (NULL = any), `min_months_service`, `max_months_service`, `entitlement_days` |
| `employee_leave_profiles` | leave-side employee attributes | `work_state`, `work_week` (override) |
| `employee_leave_assignments` | employee → policy, per leave type | `policy_id`, `entitlement_days_override` |
| `public_holidays` | **tenant deltas only** | `holiday_date`, `name`, `scope`, `observed` |
| `leave_balance_adjustments` | carry-forward + corrections | `leave_year`, `days`, `kind` (`carry_forward`/`adjustment`/`encashment`) |
| `leave_requests` | created here, **written by S7** | balance-relevant columns only — see below |

Design notes worth knowing before changing anything:

- **Carry-forward lives on the policy, not the type.** PRD-006 lists it under
  leave types; in practice the cap moves with the entitlement. So the type
  carries `carry_forward_allowed` (is this kind of leave carryable at all —
  annual yes, sick no) and the policy carries the cap and the expiry window.
- **Work week is 7 fractions, index 0 = Sunday**, not a bitmask: `1` = full
  working day, `0.5` = half day, `0` = non-working. A bitmask cannot express the
  Saturday half-day PRD-006 asks for, and Kelantan/Terengganu's Sun–Thu week is
  just a different array. Tenant default, optionally overridden per employee —
  one tenant genuinely can have a KL head office on Mon–Fri and a Kota Bharu
  branch on Sun–Thu.
- **`work_state` is on a leave-owned table, not on `employees`.** It keeps leave
  concerns in the leave module, and it meant S6 added no column to a table the
  concurrently-built S5 branch also reads.
- **No hard deletes** for types and policies (`archived_at`), per the
  system-wide convention. Holiday overrides *are* really deleted, because
  removing one restores the shipped calendar — it is configuration, not history.
- **`leave_settings.defaults_seeded_at` makes the seed run once.** A tenant that
  archives a leave type it does not offer does not find it back tomorrow.

### The `leave_requests` handoff to S7

S6 creates the table and owns **no** write path for it: no routes, no events, no
state machine. It exists in this migration because two of S6's own acceptance
criteria are about it — a pending request must reduce the available balance, a
rejected one must restore it — and a balance defined as
`entitlement − taken − pending` cannot be built or tested without the thing
being consumed.

The columns present are the balance-relevant ones only: `employee_id`,
`leave_type_id`, `start_date`, `end_date`, `start_half_day`, `end_half_day`,
`working_days`, `state`. **S7 adds `reason`, `attachment_file_id`, the approval
linkage and the `leave.*` events additively**, and owns the state machine. S6's
tests insert rows directly through `env.DB`.

`working_days` is stored, not recomputed, so a later holiday correction cannot
silently restate a request somebody already approved.

## Balances

```
available = entitlement + carried-forward + adjustments − taken − pending
```

Nothing is stored. A balance is recomputed on every read from the policy, the
employee's dates and their requests, so there is no counter to drift out of step
with reality. Four properties are load-bearing, and each has a test in
`test/leave-balances.test.ts`:

- **Pending counts.** A submitted-but-undecided request reduces the available
  balance immediately, or employees over-book against days they already asked for.
- **Rejection restores**, and it falls out of the design rather than needing its
  own code path: only `pending` and `approved` rows are summed.
- **Carried days are consumed first**, so an expiry rule lapses the leftovers
  instead of eating this year's entitlement.
- **A year-spanning request is charged to each year separately** — a
  28 December–5 January break is not four days of one year's balance and two of
  nothing.

Two conventions stop a balance moving on a day when nothing happened:

- The **tenure band is evaluated at the end of the leave period**, not at the
  moment of the query. Someone crossing two years' service in August is on the
  12-day band for the whole of that year rather than watching their entitlement
  jump mid-year.
- **Pro-rating counts whole calendar months, joining and leaving month
  inclusive**, rounded to the nearest half day. A 1 July joiner on 14 days gets
  14 × 6/12 = 7, which is PRD-006's own acceptance criterion.

### Accrual methods

| Method | Period | Behaviour |
|---|---|---|
| `annual_upfront` | calendar year | Granted in full at the start, pro-rated for a partial year |
| `monthly_accrual` | calendar year | `entitlement/12` per completed month, so it grows through the year |
| `on_anniversary` | the employee's own year, starting at their start date | Granted in full at each anniversary; no pro-rating, because the period starts there |

The **leave year is the calendar year** for the first two — which is how
Malaysian companies refresh annual entitlement. There is no fiscal-year leave
cycle; add one only when a design partner needs it.

### Carry-forward and the year close

`POST /v1/people/leave/year-close` computes what each employee carries into the
next year and writes it as a `carry_forward` adjustment row.

Carry-forward is the one part of a balance that *cannot* be recomputed later —
it depends on the cap as it stood at close — which is why it is written down
rather than derived. The write is `INSERT OR IGNORE` against a **partial unique
index** on `(tenant_id, employee_id, leave_type_id, leave_year) WHERE kind =
'carry_forward'`, so running the close twice is a no-op rather than
double-crediting everybody; the response reports `written: false` for a
(employee, type) pair that was already closed. `dry_run: true` previews.

Unused days are measured **after** pending requests, so days already asked for
are not carried and then spent twice. Only types with `carry_forward_allowed`
and a policy cap above zero produce a row.

`carry_forward_expiry_months` (3 = "use it by 31 March", the common Malaysian
setting; NULL = never lapses) retires the *unused* portion of the carried days
at the cutoff. Because carried days are spent first, an employee who used three
of five carried days in February keeps those three and lapses two, with this
year's entitlement untouched.

Admin-only: it writes irreversible rows for every employee at once, so the route
is held to `admin:write` above the router's `people:write` gate.

## Public holidays

The shipped calendar is `src/modules/leave/holidays/data.ts`, currently 2025,
2026 and 2027. States are ISO 3166-2:MY alpha codes in `holidays/states.ts` — a
code registry in TypeScript, like `src/departments/registry.ts`, because the
list is fixed by geography rather than by tenant.

### Accuracy, and what to do about it

Fixed-date holidays are certain. Islamic dates depend on moon sighting and
Chinese and Hindu dates on the lunar calendar, so a future year is a projection
until the gazettes confirm it. Each year therefore carries `provisional`, and
**the API surfaces it** (`holiday_data_provisional`, `source_note`) — an office
manager should be told which numbers are still soft rather than finding out in
April.

A year we have not shipped at all returns `holiday_data_available: false`
rather than an empty holiday list that reads as "no holidays this year". Day
counting still works for such a year, with the flag set: erroring would make
leave unbookable, and silently counting would over-deduct.

**Known gaps in the shipped dataset**, all fixable by a tenant override without
waiting for a release:

- **Perak and Kelantan ruler birthdays are omitted** rather than guessed. The
  other fourteen states' ruler/governor birthdays are included.
- **Substitution days are not modelled** — a holiday falling on a Sunday being
  observed on the Monday is gazetted per state per year.
- Hospitalisation leave is modelled as its own 60-day type. The Act frames it as
  an aggregate *including* outpatient sick leave; CompanyOS separates them
  because that is how Malaysian SMEs administer it, and because one combined
  bucket cannot express "medical certificate required for hospitalisation but
  not for one day off sick".

### Adding a year

Append a `HolidayYear` to `MY_PUBLIC_HOLIDAYS`, set `provisional` honestly, and
run `npm test`. `test/leave-holidays.test.ts` checks the structure — dates
inside their own year, valid scopes, no duplicate date+name pairs, the five
compulsory national holidays present. It cannot check that the dates are
*right*; only the gazette can do that.

No migration, no backfill, no per-tenant action. Tenant overrides survive
untouched because they are stored separately.

## Seeded Malaysian defaults

Seeded per tenant, once, on the first read of types or policies —
`annual`, `sick`, `hospitalisation`, `maternity`, `paternity`, `compassionate`,
`unpaid`. All editable, none hardcoded; nothing downstream keys off them.
`code` exists so the seed is idempotent, and `statutory_basis` — not `code` —
is what drives the warning, so a tenant renaming "Sick" to "Medical Leave"
keeps it.

Entitlements are the Employment Act 1955 minimums as amended in 2022: annual
8/12/16 days by under-2 / 2–5 / 5+ years of service, sick 14/18/22,
hospitalisation 60, maternity 98, paternity 7. The annual default ships a
5-day carry-forward cap expiring after 3 months, which is the common SME
setting. Compassionate (3 days) and unpaid have no statutory basis and never
warn; unpaid is the one type with `allow_negative_balance`.

> These are a **starting point for tenants to edit, not compliance guidance**.
> PRD-006's own open questions ask for the post-2022 figures to be confirmed
> with HR/legal before they are relied on.

## API

Gated by the mount table in `src/index.ts`. Two surfaces, on two different
capability axes:

**HR administration — `/v1/people/leave/*`, `people:read` / `people:write`.**
Same bar as the employee directory: `finance`, `support` and the self-service
`employee` tier get a 403, because entitlements and policy are HR data.

| Method | Path | Notes |
|---|---|---|
| GET, PUT | `/settings` | tenant work week |
| GET, POST, PATCH | `/types`, `/types/:id` | `?include_archived=true` |
| GET, POST, PATCH | `/policies`, `/policies/:id` | bands nested; response carries `warnings` |
| GET | `/statutory-minimums` | the Employment Act tables |
| GET, PUT | `/employee-profiles?employee_id=` | work state, work-week override |
| GET, PUT | `/assignments?employee_id=` | employee → policy |
| GET | `/states` | state list + shipped years |
| GET, POST, DELETE | `/holidays`, `/holidays/:id` | POST upserts an addition or a suppression |
| GET | `/balances?employee_id=&as_of=&leave_type_id=` | |
| GET | `/working-days?employee_id=&start=&end=&start_half_day=&end_half_day=` | |
| POST | `/adjustments` | manual correction or encashment |
| POST | `/year-close` | **`admin:write`**; `dry_run` supported |

**Employee self-service — `/v1/me/leave/*`, on the `self` axis.** Every role
holds `self`, so the `employee` tier — refused everywhere else under `/v1` —
reads its own balance without any business access. Ownership is resolved from
the session, so there is no id to tamper with.

`GET /v1/me/leave/balances` · `/types` · `/holidays?year=` ·
`/working-days?start=&end=`

`LeaveError` maps to 400 (`invalid_request`), 404 (`not_found`), 409
(`code_taken`, `archived`) and 422 (`invalid_work_week`, `invalid_employee`,
`invalid_leave_type`, `invalid_policy`).

---

# Part two — requests, approval and the team calendar (S7)

## Balance is derived, and approval does not mutate it

Nothing stores a balance and nothing decrements a counter.
`getBalances()` computes it on read. Three of PRD-006's acceptance criteria fall
out of that for free:

| Criterion | Why it holds |
|---|---|
| "a pending 3-day request reduces available balance by 3 immediately" | `pending` is in `CONSUMING_STATES` |
| "a rejected request restores the balance" | `rejected` is not, so it stops being subtracted the moment state changes |
| "on approval the balance is decremented" | it already was, at submission — approval just moves the days from the pending bucket to the taken bucket |

That third row is the load-bearing one: **a pending → approved transition leaves
`available` unchanged.** There is no decrement to lose, which is why this module
transitions state from an *event consumer* rather than reaching into the
approvals primitive for a synchronous hook.

S5's claims have the opposite shape — a journal entry is a real side effect, and
PRD-006 demands it be atomic with the decision. Do not copy this module's
consumer pattern into claims posting without reading that requirement first.

## Known simplification

Days are attributed to the calendar year of `start_date`, so leave spanning New
Year counts entirely against the year it starts in. Splitting a span across two
entitlement years needs a per-day accrual model, which is S6 territory, and
PRD-006 has no criterion for it.

---

## State machine

```
pending              → approved | rejected | cancelled
approved             → cancellation_pending | cancelled (admin only)
cancellation_pending → cancelled | approved
rejected, cancelled  → terminal
```

`cancellation_pending` exists to implement one PRD-006 sentence literally:
*"Employee may cancel while pending; cancelling an approved future leave requires
re-approval or admin action."* Three branches, in `cancelLeaveRequest`:

1. **Pending** → cancelled outright, and the pending approval is cancelled through
   the primitive.
2. **Approved + actor is admin** → cancelled outright. The "admin action" half.
3. **Approved + anyone else** → `cancellation_pending` plus a **second** approval
   row. The employee does not un-take approved leave unilaterally.

The decision handler tells the two meanings of one `approval.approved` apart by
the state it finds the request in, so no extra column is needed. A
`cancellation_pending → cancelled` transition emits `leave.cancelled`, not
`leave.approved` — the event describes what happened to the leave, not which
button was pressed.

Approved leave that has **already started** is a 409 in every branch. Handing back
days somebody has already been absent for needs a balance adjustment nobody has
specified.

---

## Approvals

Every human decision goes through the S3 primitive. `submitLeaveRequest` calls
`requestApproval()` with `subject_employee_id` set, so resolution walks up the
**subject's** reporting line rather than the filer's — the case where HR files
leave on somebody else's behalf. Resolution then skips anyone without a live
console login and terminates at a tenant admin (SESSION-PLAN C1). This module
never inserts into `approvals`.

Submission raises the approval *after* inserting the request, and deletes the row
if the approval fails (a tenant with nobody able to decide is a legitimate 422).
D1 has no multi-statement transaction here, and a compensating delete on a row
nothing else can have seen is the honest version of one.

### The decision consumer

`applyLeaveDecision` in `src/modules/people/leave/consumer.ts`, hooked into
`processEvent` beside `fanoutNotifications`. It dispatches on
`subject_type === "leave_request"`, never throws, and its UPDATE is guarded on the
state it expects — so a redelivered event changes nothing and emits nothing.

On the free plan `src/queue/direct.ts` awaits `processEvent`, so the transition
happens inside the approver's HTTP request. On the queue path a throw retries into
the DLQ.

---

## HTTP

Mounted `["/v1/leave", "self", leave]`.

### Why `self`, and why not `/v1/me/leave`

The **module** is `self`, as PRD-006 and PRD-008 require: the `employee` tier
holds no business capability, and filing leave is what that tier exists to do.
Gating leave on `people` would mean needing read access to the HR directory —
employment terms, everyone's records — to book a day off.

The **path** is not `/v1/me` despite PRD-006's wording, because a leave request
must be readable by its *approver*, who is not "me".
`src/gateway/routes/me.ts` holds as an invariant that ownership is "resolved from
the session's user id, never from a path parameter", and serving somebody else's
record from `/v1/me/...` would quietly break that promise for every other route
in that file.

| Route | Notes |
|---|---|
| `GET /v1/leave/types` | Readable by anyone who can log in |
| `GET /v1/leave/balances?employee_id=&year=` | Own by default; another's needs `people:read` |
| `POST /v1/leave/preview` | Working days **before** submission, plus balance-after, overlaps and blockers |
| `POST /v1/leave/requests` | Submit. `employee_id` for someone else needs `people:write` |
| `GET /v1/leave/requests?scope=mine\|team\|all` | `mine` default; `all` needs `people:read` |
| `GET /v1/leave/requests/:id` | Per-row auth — see below |
| `POST /v1/leave/requests/:id/cancel` | The employee it is about, or an admin |
| `GET /v1/leave/calendar?from=&to=&team_id=` | Own team by default; filters need `people:read` |

### Per-row read access

`mayReadRequest()` — one predicate, four ways in:

- the employee the leave is about (via their linked login),
- **anyone holding an approval on that row** (any state, because the inbox lists
  decided items too),
- a `people:read` holder, or an admin.

The second is what makes the approvals card work for a team lead whose role grants
no `people:read`, and it is scoped to a single subject id. A caller failing all
four gets **404, not 403** — a 403 would confirm the id exists.

`POST .../cancel` is the exception that returns 403 rather than 404: a manager may
legitimately be able to read a row they cannot cancel, so hiding it there would
contradict the GET.

### Preview and submit run the same computation

`submitLeaveRequest` calls `previewLeaveRequest` and refuses when `blockers` is
non-empty, so the console can never show a green preview for a request the API
will reject. The overlap blocker maps to **409** (PRD-006 names that status);
everything else is **422** with structured detail.

Blockers: `unknown_leave_type`, `insufficient_balance` (with `shortfall_days` and
`available_days`), `attachment_required`, `half_day_not_allowed`,
`max_consecutive_days`, `no_working_days`, `overlapping_request`.

Warnings, all non-blocking: `team_overlap`, `unpaid_leave`,
`policy_not_configured`.

### Overlap: 409 one way, a warning the other

- **Same employee**, any leave type, any live state → **409**. Two live requests
  for one person over one day cannot both be honoured.
- **A teammate's approved leave** → **warning**, never a block (PRD-006: "warn, do
  not block").

Peers are the same `team_id` **or** the same `manager_employee_id`. Team alone
would be the obvious predicate, but `team_id` is nullable and plenty of small
tenants never create teams — the headline feature would then silently do nothing
for exactly the companies this PRD targets.

### Working-day arithmetic

`src/modules/people/leave/calendar.ts`, pure functions over a `WorkCalendar`.
Every date is parsed as UTC midnight: `new Date("2026-08-01")` is UTC midnight but
`new Date(2026, 7, 1)` is local midnight, and mixing them shifts a leave span by a
day for anyone east of Greenwich — which is everyone in the only market this PRD
is for.

Half days apply to the first and last **working** dates, not the first and last
calendar dates, so a Saturday-start request with `start_half_day` deducts the half
from Monday. A holiday landing on a non-working day is reported as
`non_working_day`, because calling it a holiday would imply the employee got
something for it.

`preview.excluded_days` exists so the console can show the arithmetic. An office
manager who cannot see why 7 days became 5 does not trust the 5.

---

## Events

Registered in `src/schemas/events/registry.ts`, `source_module: "people"`.

| Event | Emitted by |
|---|---|
| `leave.requested.v1` | `submitLeaveRequest` |
| `leave.approved.v1` | the consumer, on `pending → approved` **and** `cancellation_pending → approved` |
| `leave.rejected.v1` | the consumer, on `pending → rejected` |
| `leave.cancelled.v1` | `cancelLeaveRequest` (pending withdrawal, admin cancel) and the consumer (`cancellation_pending → cancelled`) |

Every payload carries `employee_user_id` beside `employee_id`, because consumers
deal in users and `employees.user_id` is nullable — the same reason
`approval.requested.v1` carries both parties.

### Exactly one notification mapper

`leave.cancelled` is the only `leave.*` entry in `NOTIFICATION_MAP`, and the
restraint is deliberate. S4's `approval.*` mappers already notify the approver on
submission and the employee on a decision, so registering `leave.requested`,
`leave.approved` or `leave.rejected` would produce two badges for one event.

`leave.cancelled` is the genuine gap: an admin cancelling somebody's approved
leave involves no approval decision, so no `approval.*` event exists and the
employee would find their leave gone and never be told. The mapper skips when
`cancelled_by` is the employee themselves.

---

## Files

`leave_attachment` is a new `purpose` in `src/modules/files/policy.ts` — a code
change, no migration, per S2's design. Default policy (10 MB, the four content
types) and **never publicly readable**: it is health information about a named
employee, the most sensitive thing this system stores.

Submission verifies the file exists, belongs to the tenant, and carries that
purpose. Otherwise a caller could point a leave request at somebody's expense
receipt and have the approval card render it to whoever approves the leave.

---

## Console

| Screen | Route | Where it appears |
|---|---|---|
| My leave — balances, request form with live preview, my requests | `/leave` | "You" in the sidebar, beside Approvals |
| Leave calendar — person × day for one month | `/leave/calendar` | People department tool |
| Leave request detail | `/leave/requests/:id` | Notification deep-link target |

The approval card is
`ui/src/features/approvals/renderers/LeaveRequestCard.tsx`, registered as
`leave_request` in the renderer registry. It fetches its own subject and carries
everything a decision needs — dates, working days, remaining balance after
approval, overlapping team leave, reason, attachment — because PRD-007's goal is a
decision in 30 seconds on a phone without leaving the inbox.

"My leave" sits under **You**, not under the People department, because the
self-service tier sees no department groups at all — and those are exactly the
people filing leave. The calendar is the manager-facing half and lives in the
People department in *both* registries (`src/departments/registry.ts` and
`ui/src/lib/departments.ts`); `ui/src/lib/departments.test.ts` is a parity test.

The calendar shows `approved` and `cancellation_pending` only. Pending requests
are excluded because the question it answers is "who will actually be absent", and
padding it with requests that may yet be refused would make it useless for
planning cover.

---

---

# Tests

| File | Covers |
|---|---|
| `test/leave-policy.test.ts` | seeded defaults and seed-once, type/policy CRUD, **statutory warnings that never block**, default-policy uniqueness, work-week validation, capability gating |
| `test/leave-holidays.test.ts` | shipped-dataset integrity, the three holiday acceptance criteria, tenant additions/suppressions/renames, tenant isolation, unshipped and provisional years, self-service holidays |
| `test/leave-balances.test.ts` | the five entitlement acceptance criteria, all three accrual methods, band selection, overrides, year-spanning requests, carry-forward cap/expiry/idempotency, self-service balance |
| `test/leave-requests.test.ts` | working-day counting (weekends, state holidays, Sun–Thu weeks, half days), the reconciled S6 seam, preview, submission, the over-balance / attachment / overlap criteria, balance maths, tenant isolation |
| `test/leave-approval.test.ts` | approval routing (manager, C1 upward walk, admin fallback), the decision consumer and its idempotency, **PRD-000's cancelled-subject criterion**, all three cancellation branches, per-row read access |
| `test/leave-calendar.test.ts` | the overlap warning, the calendar read and its window, visibility by role |
| `ui/src/features/approvals/renderers/LeaveRequestCard.test.tsx` | every field PRD-006c names on the card, plus the unavailable-subject fallback |

Harness notes worth knowing before adding a test here:

- **Every statutory test asserts both** that the warning appears and that the
  value saved as entered. A test that only checked for the warning would pass
  against an implementation that rejected the write.
- **Decisions must go through the inline bus, not HTTP.** `worker.fetch` gets the
  test env, which has a real EVENTS queue binding — nothing drains it inside a
  test, so `processEvent` never runs and no downstream effect is observable. Use
  `decide()` on an env with `ensureEventBus` and EVENTS deleted; that is also the
  real free-plan path.
- **Dates are pinned to a hardcoded 2027**, with weekday-named constants
  (`MON`, `TUE`, …). Deriving them from `now` would break the weekday assertions
  every January.
- **Balance expectations name `ANNUAL_ENTITLEMENT_DAYS`, not a literal.** Since
  the halves were reconciled these tests read S6's real tenure band (12 days for
  the fixtures), not the port's flat provisional 8. Anything asserting 8 is
  asserting the fallback, which now means the test is pointed at the wrong
  thing.
