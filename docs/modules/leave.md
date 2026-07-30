# Leave requests

**Shipped:** S7 (PRD-006c) · **Migration:** `0026_leave_requests.sql`
**Depends on:** the approvals primitive ([`approvals.md`](approvals.md)), notifications
([`notifications.md`](notifications.md)), files ([`files.md`](files.md)), People
([`people.md`](people.md))
**Incomplete without:** S6 (leave policy, entitlement, public holidays) — see
[The S6 seam](#the-s6-seam)

An employee requests leave, it routes to their manager through the approvals
primitive, and a team calendar shows who is off. One table, `leave_requests`.

---

## The split with S6

PRD-006 splits leave across two sessions and the seam is PRD-006's own balance
formula:

```
available = entitlement + carry_forward − taken − pending
            └────── S6 owns ──────────┘   └── S7 owns ──┘
```

**S6 owns entitlement:** `leave_types`, `leave_policies`, tenure bands, accrual
methods, pro-rating for mid-year joiners, carry-forward caps, `public_holidays`
with state variation, and the configurable work week.

**S7 owns consumption:** `leave_requests`, which is where `taken` and `pending`
come from. That is the whole of this module.

### Balance is derived, and approval does not mutate it

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

### Known simplification

Days are attributed to the calendar year of `start_date`, so leave spanning New
Year counts entirely against the year it starts in. Splitting a span across two
entitlement years needs a per-day accrual model, which is S6 territory, and
PRD-006 has no criterion for it.

---

## The S6 seam

S6 was being built concurrently with S7 and its tables are not guaranteed to
exist. Everything S7 needs from S6 goes through **one file**:
`src/modules/people/leave/policy-port.ts`, with three read functions:

- `getLeaveTypes(env, tenantId)`
- `getEntitlement(env, tenantId, employee, leaveTypeCode, year)`
- `getWorkCalendar(env, tenantId, employee, year)`

Each is `try { S6 query } catch { provisional fallback }`, warning once per
tenant per concern with a `[leave/policy-port]` prefix. The catch covers two
expected cases: the table not existing yet, and **the table existing with
different column names than the port guesses** — S6's schema was not settled when
this was written, so those queries are a reading of PRD-006's wording, not a
contract S6 agreed to.

### Reconciling when S6 lands

1. Run `npx vitest run test/leave-requests.test.ts` and look for
   `[leave/policy-port]` warnings.
2. Correct the queries in `policy-port.ts` to match S6's actual columns.
3. Delete the fallbacks. Nothing else in the module references them.

**Do not widen the catch to silence the warning.** The warning is the signal that
reconciliation is outstanding, and `Entitlement.source` / `WorkCalendar.source`
carry `"default"` all the way out to the API and into the console, so both the
employee's balance page and the approval card say "leave policy is not
configured" rather than presenting a guess as policy.

### What the fallbacks deliberately are not

PRD-006's seven named Malaysian leave types with a flat entitlement each,
Mon–Fri, and **no public holidays**. No tenure bands, no accrual methods, no
pro-rating, no carry-forward, no state variation, no configurable work week, no
statutory-minimum warnings. Every one of those is an S6 deliverable with its own
acceptance criteria; half-implementing them here would give S6 two places to fix.

`leave_requests.leave_type_code` is a **code, not a foreign key** to
`leave_types`, precisely so the two migrations are order-independent.

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

## Tests

| File | Covers |
|---|---|
| `test/leave-requests.test.ts` | Working-day counting (weekends, state holidays, Sun–Thu weeks, half days), the S6 seam, preview, submission, the over-balance / attachment / overlap criteria, balance maths, tenant isolation |
| `test/leave-approval.test.ts` | Approval routing (manager, C1 upward walk, admin fallback), the decision consumer and its idempotency, **PRD-000's cancelled-subject criterion**, all three cancellation branches, per-row read access |
| `test/leave-calendar.test.ts` | The overlap warning, the calendar read and its window, visibility by role |
| `ui/src/features/approvals/renderers/LeaveRequestCard.test.tsx` | Every field PRD-006c names on the card, plus the unavailable-subject fallback |

Two harness notes worth knowing before adding a test here:

- **Decisions must go through the inline bus, not HTTP.** `worker.fetch` gets the
  test env, which has a real EVENTS queue binding — nothing drains it inside a
  test, so `processEvent` never runs and no downstream effect is observable. Use
  `decide()` on an env with `ensureEventBus` and EVENTS deleted; that is also the
  real free-plan path.
- **Dates are pinned to a hardcoded 2027**, with weekday-named constants
  (`MON`, `TUE`, …). Deriving them from `now` would break the weekday assertions
  every January.
