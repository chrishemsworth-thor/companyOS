# Approvals

The approvals primitive (PRD-000b). One table, one service, one HTTP surface —
every module that needs a human decision routes through it, and none of them
ships its own approvals table.

> **Not deployed on its own.** An approvals backend nobody can see is not a
> feature: there is no console surface for it until PRD-000c + PRD-007 (S4)
> ship the notification consumer and the inbox. Deploy the two together. This
> is the failure mode PRD-007 exists to prevent.

## Using it from a module

Call the service. There is deliberately no `POST /v1/approvals`, because a
request for a decision always originates from a subject — a claim, a leave
request — and letting a client conjure one would create approvals pointing at
subjects that do not exist.

```ts
import { requestApproval, cancelForSubject } from "../approvals/service";

// When the subject is submitted:
const approval = await requestApproval(env, tenantId, {
  subject_type: "expense_claim",
  subject_id: claimId,
  requested_by: actorUserId,          // null for programmatic callers
  idempotency_key: `claim-${claimId}-submit`,
});

// When the subject is withdrawn or deleted:
await cancelForSubject(env, tenantId, "expense_claim", claimId);
```

Then consume `approval.approved` / `approval.rejected` to act on the decision —
that is where S5 posts an approved claim to the GL and S7 deducts a leave
balance. Do not poll the table.

**Adding a subject type costs no migration.** Add a value to
`subjectTypeSchema` in `types.ts` and a line to `SUBJECT_STRATEGIES` in
`resolution.ts`. That is the whole change, and it is what PRD-000's success
metric requires: `approvals.subject_type` is plain `TEXT` with no SQL `CHECK`,
precisely so a consuming module never has to touch the schema. `state` *does*
carry a `CHECK` — it is this primitive's own vocabulary and nobody extends it.

## Approver resolution

The interesting part, and the reason to read `resolution.ts` before changing
anything. Approvals route to **users**; reporting lines run between
**employees**; and `employees.user_id` is nullable. So PRD-000's default
strategy — "the employee's manager via People reporting lines" — can resolve to
somebody who cannot log in to act, leaving the request pending forever with no
error. PRD-000 covers *no manager set*; it does not cover *manager set, no
login*. See SESSION-PLAN conflict C1.

Resolution is therefore **one upward walk, not three special cases**. Climbing
`manager_employee_id`, a candidate is accepted only if they have a linked
`user_id`, that user is `active`, and they are not the requester. Anything else
and the walk continues. One recursive CTE, depth-bounded at 100 exactly like
`assertNoManagerCycle` in `src/modules/people/service.ts`, so a reporting cycle
terminates instead of spinning.

That single predicate satisfies three separate PRD-000 acceptance criteria —
no manager set, manager with no login, and requester-is-the-approver — so none
of them has its own code path. Order of resort:

1. **The strategy for the subject type.** `manager_chain` for leave, claims and
   `other`; `role_based` (`finance`, then `admin`) for quotes and invoices,
   because a financial document is not signed off by the requester's line
   manager.
2. **A tenant admin** who is not the requester.
3. **The requester themselves, only if they hold `admin`.** This looks like it
   contradicts the self-approval block, but PRD-000 blocks self-approval
   *unless the approver holds admin*, which is exactly this case. It exists
   because a one-person finance function is the common Malaysian SME shape:
   refusing to create the approval would make claims and leave unusable for a
   tenant with a single admin.
4. **Nothing** → `no_approver`, HTTP 422, and **no row is written**, so a tenant
   in this state has no unactionable approvals to clean up later.

A row can therefore never name an approver unable to act.

## Decisions

Terminal. `pending → approved | rejected | cancelled`; everything else is a
dead end, and re-deciding returns **409 naming the current state**, matching
`src/modules/support/state-machine.ts` as PRD-000 asks. The audit record is
only defensible if it is immutable.

Authorization on `decide()`, in order — existence (tenant-scoped, so another
tenant's id is a **404, never a 403**), then the assigned approver or an admin,
then the self-approval block unless the decider holds `admin`. The state guard
runs last, so an unauthorized caller learns nothing about the row's state.

`cancel()` is **not** a decision: no event, and `decided_by`/`decided_at` stay
NULL, because nobody decided anything. The subject module emits its own
`*.cancelled` event; a second `approval.cancelled` here would have the
notification consumer telling an approver about work that has simply
evaporated.

**Rejection is terminal for its row, and resubmission is a new row.** There is
no `supersedes` column (SESSION-PLAN C8). PRD-006 allows resubmission after
rejection; the subject already owns its own history, so the linkage exists
without the primitive growing a column for it. If S4's inbox turns out to need
"this replaces an earlier rejected request", decide it there with the screen in
front of you.

## HTTP

| Route | Notes |
|---|---|
| `GET /v1/approvals` | `?state=`, `?subject_type=`, `?subject_id=`, `?mine=true` (awaiting me), `?requester=me` (raised by me), plus `?limit=`/`?cursor=`. **Oldest first** — the longest wait is the most likely blocker. `approval_id` is a ULID, so that ordering is chronological and cursor pagination works on it directly. |
| `GET /v1/approvals/:id` | Another tenant's id is a 404. |
| `POST /v1/approvals/:id/approve` | Optional `{ comment }`. |
| `POST /v1/approvals/:id/reject` | Optional `{ comment }` — see below. |
| `POST /v1/approvals/:id/cancel` | Requester or admin only. Beyond PRD-000's three routes; see below. |

No router-level `requireRole`: every authenticated user legitimately has an
approvals queue, so the question is never "what role are you" but "is this row
yours", and that is answered per row in the service.

**A tenant API key cannot decide.** It authenticates a tenant, not a person, so
there is nobody to write into `decided_by`, and an audit trail naming "the
tenant" is not an audit trail. `?mine=true` and the decision routes 400 for
API-key callers.

Two deliberate divergences from PRD-000's letter:

- **`reject` does not require a comment.** PRD-000 says "approve or reject with
  an optional comment"; PRD-007's console requires one on reject and enforces
  it client-side. Keeping the primitive permissive means a module calling
  `decide()` programmatically is not blocked by a UI rule.
- **`/cancel` exists**, though PRD-000 lists only three routes. PRD-007's "My
  requests" tab lets a requester withdraw their own pending request, and the
  generic inbox cannot know which subject module owns a given row — without
  this, the console would have to reach into a module it does not own. It is
  restricted to the requester (or an admin), so an *approver* cannot use it to
  duck a request they simply do not want to answer.

## Events

Registered in `src/schemas/events/registry.ts`; the consumer rejects
unregistered types outright, so these are hard requirements, not conventions.
Wire types are unversioned (`approval.requested`) while the schema files carry
`.v1`, matching the existing registry convention and the envelope's
`<entity>.<action>` regex.

| Event | Emitted when |
|---|---|
| `approval.requested` | A request is raised. |
| `approval.approved` | Approved. |
| `approval.rejected` | Rejected. |

`source_module` is **`platform`**, a value this session added to
`sourceModuleSchema`: approvals belong to no single business module, and
attributing an event that leave, claims, quotes and support all raise to
"people" or "finance" would misattribute it. `events_log.source_module` is plain
`TEXT` with no `CHECK`, so this needed no migration.

Every payload carries **both** `requested_by` and `approver_user_id`, because
S4's notification consumer notifies the approver on a request and the requester
on a decision, and must not need a database lookup to know who they are.
`approval.requested` also carries `resolution_strategy` and `resolution_hops`,
which is what makes a surprising route debuggable after the fact.

There is deliberately **no `approval.cancelled`** — see `cancel()` above.

## Tests

`test/approvals.test.ts` — 45 tests in the real Workers runtime. Every PRD-000
acceptance criterion, plus the C1 cases the PRD does not cover (manager with no
login, manager with a *disabled* login, a three-deep chain with no logins
anywhere terminating at admin), the reserved `invoice` type (C5), resubmission
after rejection (C8), the solo-admin fallback, tenant isolation on every path,
idempotency, a reporting cycle terminating rather than looping, and one
end-to-end pass through the queue-less consumer so an unregistered type or a
rejected payload cannot slip through on the free-plan path.
