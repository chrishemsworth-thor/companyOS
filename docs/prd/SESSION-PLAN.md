# PRD 000–009 — Multi-Session Build Plan

**Authored:** 2026-07-25 · **Covers:** every PRD in this directory
**Source docs:** [`README.md`](README.md) (index & sequencing) ·
[000](PRD-000-platform-foundations.md) ·
[001](PRD-001-finance-ledger-completeness.md) ·
[002](PRD-002-agent-portability-and-eval.md) ·
[003](PRD-003-crm-depth.md) ·
[004](PRD-004-quote-branding-and-signing.md) ·
[005](PRD-005-support-intake-and-tracking.md) ·
[006](PRD-006-people-leave-and-claims.md) ·
[007](PRD-007-console-approvals-inbox.md) ·
[008](PRD-008-roles-and-permissions.md) ·
[009](PRD-009-project-scheduling.md)

> **PRD-008 has no session slot yet.** It arrived after the original eight were
> sequenced, it is marked **P0** ("security gap"), and its own header says it
> blocks PRD-006 employee self-service — which is S6/S7. It therefore needs a
> number *and* a position earlier than its number would imply. Not slotted here
> because that is a sequencing decision, not a clerical one. See "Unslotted work".

This file exists because the eight PRDs are being built across **separate Claude
Code sessions**. Each session starts with no memory of the last, so everything a
session needs has to be on disk. This is that handoff surface: decisions already
taken, a session map, the cross-PRD conflicts that only show up when you read
all eight together, and a self-contained brief per session.

---

## How to run a session

Ready-to-paste openers for every remaining session live in
[`SESSION-PROMPTS.md`](SESSION-PROMPTS.md) — each one names the brief, the PRD
sections, and the conflicts and decisions that session needs up front. Use those
in preference to writing your own.

The generic shape, if you need it:

> Read `docs/prd/SESSION-PLAN.md` and the brief for **S<n>**, plus the PRD it
> references. Before writing code, produce an implementation plan covering D1
> migrations, new/changed endpoints, event types to register in the schema
> registry, and the test files you will add. Confirm the plan before
> implementing. Every acceptance criterion must have a corresponding test in the
> Workers runtime suite.

### Standing rules for every session

1. **Do not weaken the append-only ledger guarantees or the multi-tenant
   isolation pattern.** If a requirement seems to need it, stop and ask.
2. **Do not invent an approvals or notifications mechanism inside a module.**
   Everything routes through the PRD-000 primitives.
3. **One session, one branch, one shippable increment.** Do not start the next
   session's scope because there is context left over.
4. `npm run typecheck && npm test` must pass before the push that closes a
<<<<<<< HEAD
   session. **Baseline after S5:** clean typecheck, 48 test files / 834 tests in
   the Workers suite, plus 14 files / 122 tests in `ui/` (`cd ui && npm test`,
   which root `npm test` does NOT run — see the console note below).
   (S5 measured `main` at 45 / 749 before starting, against the 42 / 476 recorded
   here after S4 — the number goes stale exactly as often as this rule says it
   does. S3 recorded 39 / 406; S2 recorded 38 / 346 when `main` was already at
=======
   session. **Baseline after S7:** clean typecheck, 48 test files / 844 tests in
   the Workers suite, plus 13 files / 110 tests in `ui/` (`cd ui && npm test`,
   which root `npm test` does NOT run — see the console note below).
   (S7 measured `main` at 45 / 749 before its own work — note S4 *recorded*
   42 / 476, which was already stale, so the recorded number is a floor and not a
   target. S3 recorded 39 / 406; S2 recorded 38 / 346 when `main` was already at
>>>>>>> 91f7887
   38 / 361; S1's was 37 / 321 at `b74a2f5`.) A session finding fewer passing tests than
   that has broken something. Re-check the current count on `main` before
   assuming your own change caused a drop — `main` moves between sessions, and
   the number written here goes stale exactly as often.
   **Known flake:** `test/files.test.ts > rejects a 12 MB upload with 413` fails
   intermittently under full-suite load and passes 25/25 when that file is run
   alone. It is a timing artefact, not a regression; re-run the file before
   chasing it.
5. **Take the next free migration number at session start** by checking `main`,
   not this file — session order moves and a hardcoded number here goes stale.
   As of S5, `0024_expense_claims.sql` is the highest, so the next session takes `0025`. Note `0015` is
   already duplicated (`0015_google_accounts.sql`, `0015_people.sql`); do not add
   a third collision.
6. Update the **Status** column below in the closing commit. It is the only
   cross-session progress record.

---

## Decisions already taken

Recorded so no session re-opens them.

| Decision | Made by | Detail |
|---|---|---|
| **Approver when the manager has no console login** | Chris/Josh, 2026-07-25 | **Walk up the chain.** Skip any employee with no linked `user_id`, try their manager, and so on; if nobody up the chain can log in, a tenant admin gets it. Same walk also skips the requester (self-approval). One resolution function, not three special cases. See conflict C1. |
| **Single approver in v1** | PRD-006 | PRD-000 non-goals multi-step chains; PRD-006 P0 says *"single approver in v1"* with multi-step as P1. PRD-000's scope stands unchanged — but keep `approvals` rows independent so `sequence_index`/`parent_id` are additive. |
| **Claims before leave** | PRD-006 | PRD-006's own open question answers itself: claims first (sharper demo, proves the architecture), leave immediately after, *"neither is sellable alone."* |
| **Free-plan event consumer can write rows** | S0 verification | See "Resolved open questions" below. Notifications are not blocked. |
| **Profitability's "direct cost" is dimensioned expense postings only** | S1, stated assumption | Labour cost via employee rate × logged time is excluded — CompanyOS has no time tracking and PRD-001 puts that in its own PRD. Revenue-side and expense-side rollups only. |
| **Invoices carry an optional `project_id`** | S1 | PRD-001 says "project-linked entries inherit `project_id`" but nothing linked an invoice to a project, so project *revenue* had no derivation source and the flagship agency rollup would have had a cost side only. Added as a nullable column, stamped onto both posting legs. |

---

## Session map

| # | Session | PRD | Pri | Branch | Depends on | Status |
|---|---|---|---|---|---|---|
| S0 | Plan & document landing | — | — | `claude/readme-p0-review-78jc3u` | — | **done** |
| S1 | Ledger dimensions + profitability | 001a | P0 | `claude/readme-p0-review-78jc3u`² | S0 | **done** |
| S2 | File storage primitive | 000a | P0 | `claude/s2-implementation-plan-nv4e1f`³ | S0 | **done** |
| S3 | Approvals primitive | 000b | P0 | `claude/approvals-primitive-qygql6`⁴ | S2 | **done** |
| S4 | Notifications + inbox shell | 000c + 007 | P0 | `claude/notifications-inbox-renderer-ud7gu1`⁵ | S3 | **done** |
<<<<<<< HEAD
| S5 | Expense claims + GL posting | 006a | P0 | `claude/claims-submission-approval-posting-gaa3oz`⁶ | S1, S2, S4 | **done** |
| S6 | Leave policy, holidays, balances | 006b | P0 | `claude/leave-policy-holidays-balances-4a0xcb`⁶ | S4 | **done** |
| S7 | Leave requests + team calendar | 006c | P0 | `claude/prd-006c-leave-requests` | S6 | not started |
=======
| S5 | Expense claims + GL posting | 006a | P0 | `claude/prd-006a-expense-claims` | S1, S2, S4 | not started |
| S6 | Leave policy, holidays, balances | 006b | P0 | `claude/prd-006b-leave-policy` | S4 | not started |
| S7 | Leave requests + team calendar | 006c | P0 | `claude/leave-request-approval-15v4bu`⁶ | S6 | **done** |
>>>>>>> 91f7887
| S8 | Contact roles (then attributes, health) | 003 | P1 | `claude/prd-003-crm-depth` | S1 (loose) | not started |
| S9 | Quote branding & click-to-sign | 004 | P1 | `claude/prd-004-quote-signing` | S2, S8; S3 for P1 sign-off | not started |
| S10 | Agent guardrails, eval, observability | 002 | P1 | `claude/prd-002-agent-guardrails` | — | not started |
| S11 | Support intake & tracking | 005 | P1 | `claude/prd-005-support-intake` | S2, **S4** | not started |
| S12 | Tax (SST) | 001b | P0¹ | `claude/prd-001b-tax` | S1 | not started |
| S13 | Credit notes + ledger multi-currency | 001c | P0¹ | `claude/prd-001c-credit-notes` | S1, S12 | not started |
| S14 | Project scheduling + deadline reminders | 009 | P1 | `claude/prd-009-project-scheduling` | S4 | not started |

¹ PRD-001 marks all of these P0, but the index defers tax, credit notes and
multi-currency until *"a design partner hits them"*. Treat S12/S13 as
demand-driven rather than scheduled — with one exception, see conflict C2.

² S0 and S1 both landed on this branch, merged to `main` as PR #42. Migration
`0020_ledger_dimensions.sql` is taken; S2 took `0021_files.sql`, so **S3 takes
`0022`.** Later sessions each get their own branch as listed.

³ S2 ran on the branch its session was given rather than the one named here.
The name is cosmetic; the scope is not. **S3 takes `claude/prd-000b-approvals`
as listed.**

⁴ S3, like S2, ran on the branch its session was given rather than the one named
here. Migration `0022_approvals.sql` is taken, so **S4 takes `0023`** — but check
`main` rather than trusting this line, per standing rule 5.

⁵ S4 likewise ran on its given branch. `0023_notifications.sql` is taken, so the
next session takes **`0024`** — check `main`, per standing rule 5.

<<<<<<< HEAD
⁶ S6 ran on its given branch too. **S5 and S6 were built concurrently**, so S6
took `0025_leave_policy.sql` and left `0024` to S5 rather than both reaching for
the next free number. D1 applies migrations in filename order and tolerates a
gap, so 0025 applies whether or not 0024 has landed. S6 deliberately ALTERs no
table another session owns — the two branches share no SQL. **The next session
takes `0026`** if S5 has taken `0024`; check `main`, per standing rule 5.
⁶ S5 likewise ran on its given branch. `0024_expense_claims.sql` is taken, so the
next session takes **`0025`** — check `main`, per standing rule 5.
=======
⁶ S7 also ran on its given branch. **S5, S6 and S7 were built concurrently from
the same `main`** (highest migration `0023`), so all three would have taken `0024`
— and `0015` is already duplicated once, which standing rule 5 says not to repeat.
The numbers are therefore reserved by session order: **`0024` = S5 claims,
`0025` = S6 leave policy, `0026` = S7 (taken, `0026_leave_requests.sql`)**. If S5
or S6 lands on a different number that is harmless; nothing in `0026` references
either. **S8 onwards: check `main`, do not trust this line.**
>>>>>>> 91f7887

### How this differs from the index's build order

The index's nine-step order is the skeleton; reading the PRDs changed five things.

1. **S1 includes the profitability rollup, not just dimensions.** The index says
   "ledger dimensions only". PRD-001's own phasing is *"dimensions +
   profitability rollup"* as one step, and the rollup is read-only SQL over the
   dimensions with no new write path. Splitting them would ship a schema change
   nothing reads.
2. **PRD-006 is three sessions, not two.** Leave is much larger than the index
   implies — leave types, policies with three accrual methods, pro-rating,
   carry-forward, state-varying public holidays, configurable work weeks, *then*
   requests, approval and a team calendar. PRD-006's own phasing splits policy
   from requests, and so does this plan.
3. **Contact roles move ahead of quote signing.** The index puts 004 at #5 and
   003 at #6 while noting 003 *"can be pulled earlier if it unblocks 004"* — it
   does, via the `signatory` role. Doing 003 first also means PRD-002's eval
   scenarios can cover contact-role routing when S10 runs.
4. **PRD-005 depends on notifications, not just file storage.** The index's
   graph says "005 (attachments only)". PRD-005 P0 requires assignment to notify
   the assignee through the PRD-000 primitive, with an acceptance criterion for
   it. S11 therefore depends on S4.
5. **PRD-007 splits along a shell/renderer seam.** PRD-007 says its leave and
   claim renderers ship with PRD-006 and its quote renderer with PRD-004, and to
   *"build the shell plus a generic fallback card first."* So S4 builds the
   generic inbox and each later session ships its own card. Without that split,
   S4 would block on S5, S7 and S9.

---

## Cross-PRD conflicts

The reason to read all eight before building any. Each of these is cheap to
handle now and expensive to retrofit.

### C1 — Approvals route to users; reporting lines are employees

`employees.user_id` is **nullable** ("optional console-login link"), but
`approvals.approver_user_id` is a user. So PRD-000's default strategy — the
employee's manager via People reporting lines — can resolve to somebody who
cannot log in to act. The request then sits pending forever with no error.
PRD-000 covers *no manager set*; it does not cover *manager set, no login*.

**Resolved:** walk up the chain (see Decisions). S3 implements **one** upward
walk over `manager_employee_id` that skips any employee who is the requester or
has no `user_id`, terminating at a tenant admin. `assertNoManagerCycle` in
`src/modules/people/service.ts` already proves the ancestor walk is safe and
bounded (depth < 100) — reuse that shape. This single walk also satisfies
PRD-000's *"requester is also the resolved approver"* criterion, so do not build
it twice.

### C2 — Claims posting needs a tax account that a deferred session creates

PRD-006's differentiating requirement posts
**Dr {category expense} / Dr SST Input (if applicable) / Cr Employee
Reimbursements Payable**. `SST Input` comes from PRD-001's tax work — which the
index defers to S12, *after* claims.

**Resolution:** S5 posts the two-leg entry (expense / reimbursements payable)
and treats the SST Input leg as explicitly out of scope, landing with S12. The
"(if applicable)" in PRD-006 makes this legitimate — a tenant that is not
SST-registered never needs the leg. **S5 must not invent an SST account**, and
S12 must add the third leg to claim posting when it lands. If a design partner
is SST-registered, S12 moves ahead of S5 instead.

### C3 — File reads: PRD-000 says always authenticated, PRD-004 needs public

PRD-000: `GET /v1/files/:id` requires tenant-scoped auth, and a cross-tenant
read must 404. PRD-004 P0 needs the tenant's logo rendered on an
**unauthenticated** public quote page — *"scoped public read for `quote_logo`
purpose only"*. PRD-005 P0 needs public customer uploads with **stricter**
limits than the authenticated path, and PRD-004 wants logos capped at 2 MB
against PRD-000's global 10 MB.

**Resolution:** S2 builds file policy **per `purpose`**, not one global rule —
max bytes, allowed content types, and publicly-readable yes/no, keyed on the
`purpose` enum. PRD-000's 10 MB / four-type rule becomes the default row rather
than a hardcoded constant. This is a small amount of extra work in S2 and saves
S9 and S11 each retrofitting the read path. The tenant-isolation rule is
untouched: public readability is a property of a purpose, never of a caller, and
`quote_logo` is the only purpose that gets it in v1.

### C4 — The nudge would create a notification from module code

PRD-000 is explicit that notification rows are created **by an event consumer,
not by module code**. PRD-007's nudge action is user-initiated from the inbox, so
the obvious implementation inserts a row directly and breaks standing rule 2.

**Resolution:** S4 registers `approval.nudged.v1` and emits it; the same
notification consumer maps it to a row. The 24h rate limit lives in the service
before the emit. Keeps one writer for the `notifications` table.

### C5 — `invoice` is an approvals subject type nothing ever creates

PRD-000 lists `invoice` in the `subject_type` enum and PRD-007 specs an invoice
renderer showing AR balance and health. But **no PRD contains a requirement that
requests an invoice approval** — PRD-004 covers quotes, PRD-006 covers leave and
claims, and PRD-001 does not gate invoice issue on approval.

**Resolution:** keep `invoice` as a reserved enum value in S3 and **do not build
the invoice renderer in S4**. The generic fallback card covers it if one ever
appears. Building a card for a type nothing populates costs a screen nobody
sees, and PRD-007's own criterion requires the generic fallback to exist anyway.

### C6 — PRD-002's eval suite reaches into deferred and non-existent work

Two of PRD-002's P0 items depend on things that do not exist:

- The scenario *"Disputed invoice (credit note pending) → expect `wait`"*
  requires PRD-001 credit notes (S13).
- The guardrail *"no contact outside 09:00–18:00 tenant local time"* requires a
  tenant timezone. **Verified: no timezone setting exists anywhere in `src/`.**
  PRD-002 flags this itself as a non-blocking open question; it is actually
  load-bearing for a P0 guardrail.

**Resolution:** S10 adds tenant timezone to `/v1/settings` as part of its own
scope — it is small, and the guardrail is meaningless without it. The
credit-note scenario ships as a **fixture-only context** (eval scenarios are
frozen fixture files, so the context can describe a pending credit note before
the feature exists) with a note that the agent's live context assembly will not
produce it until S13.

### C7 — PRD-003 changes a finance write path

`payment_terms_days` on the customer is *"used to compute invoice due dates
automatically, which is the point of storing it."* That is a change to invoice
creation, not to CRM. S8 therefore touches the finance module and must keep the
existing finance suites green — `test/finance-lifecycle.test.ts` and
`test/finance-service.test.ts` are the relevant nets.

### C8 — Resubmission after rejection

PRD-000 asks, as an open product question, whether a rejected request is
editable and resubmitted, and whether `approvals` needs a `supersedes` column.
**PRD-006 answers it for claims:** *"Rejection returns the claim to the employee
with a comment; resubmission allowed."*

**Recommended for S3:** a resubmission creates a **new** approval row and adds
no column. The subject (the claim) already owns its own history, so the linkage
exists without touching the primitive. Only add `supersedes` if S4's inbox needs
to render "this replaces an earlier rejected request" — decide there, with the
screen in front of you, not in S3.

---

## Resolved open questions

### PRD-000 (blocking): does the free-plan inline bus support a row-writing consumer?

**Yes. Notifications are not blocked.**

`createDirectEventBus` in `src/queue/direct.ts` builds a fake `Queue` whose
`send()` **awaits `processEvent(env, body)`** — the same function the real queue
consumer calls. `processEvent` already writes to D1 on every event (the
`events_log` insert in `logEvent`), and that works on the free plan today. A
consumer inserting notification rows behaves identically.

Two constraints S4 must design around, both documented in `direct.ts`:

1. **No retry, no DLQ.** On the inline path a throwing consumer is caught,
   logged, and **dropped** — the business write that emitted the event has
   already committed. A failed insert is a silently missing notification.
2. **Inline dispatch is synchronous with the request**, so a slow consumer adds
   latency to the API call that emitted the event.

So: make the insert idempotent on a natural key (`INSERT OR IGNORE`), keep it
cheap, and do not throw on recoverable conditions.
`test/direct-event-bus.test.ts` is the precedent for testing this path.

### PRD-005 (blocking): does the Gmail integration expose `References`/`In-Reply-To`?

**Not today — but threading is in better shape than the PRD assumes, and the fix
is one line.**

- `src/integrations/google/gmail-client.ts` `getMessage()` fetches
  `format: "metadata"` requesting only `From`, `To`, `Subject`, `Date`. So RFC822
  threading headers are **not** currently exposed.
- But `headers` is a generic `Record<string, string>`, so adding
  `"References"`, `"In-Reply-To"`, `"Message-ID"` to that array exposes them.
  No architectural change.
- **Better:** Gmail's own `threadId` is already carried end to end —
  `sync.ts` puts it on `email.received.v1` as `thread_id`, and `sendMessage()`
  already accepts a `threadId` for outbound replies. So the Gmail path can
  thread natively, and the `[#TKT-1234]` subject token drops to a genuine
  fallback for mail arriving outside the thread rather than the primary
  mechanism the PRD feared.

Two things S11 must add regardless, both concrete:

- **A body fetch.** `format: "metadata"` returns no body, and PRD-005 needs the
  email body as the ticket's first message. `email.received.v1`'s own comment
  says consumers fetch the body via `message_id` — S11 is that consumer.
- **`Auto-Submitted` and `Precedence` headers**, without which PRD-005's
  loop-protection criterion ("out-of-office auto-reply creates no ticket")
  cannot be implemented.

### PRD-002: is the documented default model still accurate?

Yes. PRD-002 cites `claude-opus-4-8`; `src/llm/anthropic.ts` exports
`DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8"`. No discrepancy.

---

## Blocking decisions still needed

None block S1–S4, so the first four sessions can run now. Later sessions need
these answered before they start.

| Question | PRD | Blocks | Recommendation |
|---|---|---|---|
| Does profitability's "direct cost" come only from dimensioned expense entries, or also employee cost rate × logged time? There is **no time tracking module**. | 001 | S1's rollup | Ship revenue-side and expense-side rollups only. Time-based cost is a separate PRD, and PRD-001 says as much. |
| Default escalation threshold in days? Malaysian SME norms run 60–90 days in practice, so 30 may be culturally aggressive. | 002 | S10 guardrails | Needs a design partner's view. Ship it tenant-configurable with a conservative default so the decision is cheap to change. |
| Should `at_risk` health auto-pause outbound sales activity, or only surface as a signal? | 003 | S8 health | Signal only in v1. Auto-pause is the more impressive behaviour and the more dangerous one; it wants real data first. |
| ~~Should high-value approvals require re-authentication?~~ | 007 | ~~S4~~ | **Answered by S4: no, not in v1.** Taken deliberately rather than by omission, as PRD-007 asks. Revisit when a tenant actually approves something large enough to care. |
| ~~Where do public holidays come from each year — manual seed or a maintained data file shipped with releases?~~ | 006 | ~~S6~~ | **Answered by S6: a shipped data file, used as an OVERLAY.** State variation makes manual seeding per tenant an annual support burden. S6 went one step further than the recommendation: the shipped calendar is never written to the database. `public_holidays` holds only tenant deltas (additions and suppressions) and the effective set is merged at read time, so the annual update is a deploy with no backfill and a tenant's own edits survive it by construction. See [`../modules/leave.md`](../modules/leave.md). |
| WhatsApp inbound before or after the public intake form? | 005 | S11 internal order | WhatsApp is how Malaysian SME customers actually complain, but needs a BSP relationship. Do the email path first either way — it is built on integrations that already exist. |
| Is `credited` a distinct invoice state or derived from credit note totals? | 001 | S13 | — |
| Confirm ECA 2006 click-accept sufficiency and the agreement text with a Malaysian lawyer. | 004 | **Customer use, not the build** | S9 can build and test the flow; do not rely on it commercially until confirmed. |

---

## New event types

`src/schemas/events/registry.ts` is a single choke point and the consumer
**rejects unregistered event types** — an unregistered event is a hard failure,
not a silent one. One Zod file per event under `src/schemas/events/`.

| Session | Events to register |
|---|---|
| S3 | `approval.requested.v1`, `approval.approved.v1`, `approval.rejected.v1` — **done** |
| S4 | `approval.nudged.v1` (see C4) — **done** |
<<<<<<< HEAD
| S5 | `claim.submitted.v1`, `claim.approved.v1`, `claim.rejected.v1`, `claim.paid.v1` — **done**. Note none is mapped in the notification consumer: the `approval.*` events already notify both parties, and a `claim.*` mapper would double the badge. |
| S7 | `leave.requested.v1`, `leave.approved.v1`, `leave.rejected.v1`, `leave.cancelled.v1` |
=======
| S5 | `claim.submitted.v1`, `claim.approved.v1`, `claim.rejected.v1`, `claim.paid.v1` |
| S7 | `leave.requested.v1`, `leave.approved.v1`, `leave.rejected.v1`, `leave.cancelled.v1` — **done** |
>>>>>>> 91f7887
| S8 | `customer.no_contact.v1` (PRD-003 writes it without a version suffix — add one, per the existing convention) |
| S9 | `quote.viewed.v1`. **`quote.accepted.v1` and `quote.rejected.v1` already exist** in the registry — reuse, do not re-add. |
| S10 | `guardrail.override.v1`, plus `collections.decision.v2` (PRD-002 extends the payload with provider, model, prompt version, tokens, latency, cost, fallback and override flags — that is a breaking payload change, so it is a v2 file and a registry bump, per the convention documented in `registry.ts`) |
| S11 | `ticket.assigned.v1`, `ticket.sla_breached.v1` |
| S13 | `credit_note.issued.v1` |
| S14 | `project.deadline_approaching.v1`, `project.overdue.v1` |

---

## Codebase facts a session will get wrong

Verified against `main` at `d1e5202` on 2026-07-25.

| Thing | Reality |
|---|---|
| `files`, `approvals`, `notifications` tables | All three **exist**: `files` (S2, `0021`), `approvals` (S3, `0022`), `notifications` + `approval_nudges` (S4, `0023`). |
| Notifications | `src/modules/notifications/` — rows written **only** by `fanoutNotifications` in `consumer.ts`, hooked into `processEvent`. A module that wants to notify somebody emits an event and adds one entry to `NOTIFICATION_MAP`; it never inserts. The consumer **never throws** (the free-plan inline path has no retry) and inserts idempotently on a `dedupe_key`. See [`docs/modules/notifications.md`](../modules/notifications.md). |
<<<<<<< HEAD
| Approvals inbox renderers | `ui/src/features/approvals/renderers/registry.ts`. **`expense_claim` registered by S5**; everything else still takes the generic fallback. S7 adds `leave_request`, S9 adds `quote`; no `invoice` card is ever built (C5). Adding one is a component plus one line in `RENDERERS`, plus one line in `ui/src/lib/subjectRoutes.ts` if the subject has a detail screen. |
=======
| Approvals inbox renderers | `ui/src/features/approvals/renderers/registry.ts`. Empty in S4; **S7 registered `leave_request`**. S5 adds `expense_claim` and S9 adds `quote`, both of which still take the generic fallback; no `invoice` card is ever built (C5). Adding one is a component plus one line in `RENDERERS`, plus one line in `ui/src/lib/subjectRoutes.ts` if the subject has a detail screen. `registry.test.tsx` and `subjectRoutes.test.ts` both pin the expected set, so each addition updates two assertions. |
>>>>>>> 91f7887
| Console tests | `ui/` has its **own** vitest (jsdom + Testing Library, `ui/vitest.config.ts`), and root `npm test` does not run it — `vitest.config.ts` includes `test/**/*.test.ts` only. A session touching `ui/` must run `cd ui && npm test` separately or its console tests never execute in CI. `@testing-library/user-event` is **not** a dependency; use `fireEvent`. |
| Name directory | `GET /v1/meta/users` (S4) — id, display name, email for the tenant, readable by **any** authenticated user. `/v1/users` is admin-only, so a non-admin manager needs this to see "requested by Aisha" instead of `usr_01J...`. |
| Approvals | `src/modules/approvals/` — `requestApproval`/`decide`/`cancel`/`cancelForSubject`, plus `resolution.ts` (the C1 upward walk) and a per-`subject_type` strategy map. A module wanting a human decision adds a `subjectTypeSchema` value and calls the service; it never inserts into `approvals`. **S5 added `decision-effects.ts`**: a per-`subject_type` hook whose statements run in the same `db.batch()` as the decision, which is the only way to get atomicity (an event consumer runs after the commit, and the free-plan inline bus drops a thrower). S7's leave deduction should use it. See [`docs/modules/approvals.md`](../modules/approvals.md). |
| Expense claims | `src/modules/claims/` (S5, `0024`) — `claim_categories` / `expense_claims` / `expense_claim_lines`, posting `Dr {category expense} / Cr 2100 Employee Reimbursements Payable`. Mounted on the **`self`** capability axis so the `employee` tier can file; row-level visibility (owner, approver, or `finance:read`). Receipts have their own two purpose-locked routes because `employee` holds no `files` capability. See [`docs/modules/claims.md`](../modules/claims.md). |
| `source_module` values | `finance`, `people`, `sales`, `support`, `build`, `comms`, and **`platform`** (added by S3 for primitives belonging to no business module). Enforced by Zod in `src/schemas/envelope.ts`, not by SQL. |
| R2 | **Bound as of S2**: bucket `companyos-files`, binding `FILES`, in *both* `wrangler.jsonc` and `wrangler.free.jsonc`. Create it once with `npx wrangler r2 bucket create companyos-files` — R2 has a free tier, so the free-plan deploy is not blocked. |
| File storage | `src/modules/files/` — `uploadFile`/`getFile`/`getPublicFile`/`deleteFile`, plus a per-purpose policy table (`policy.ts`). A module wanting to store a binary adds a `purpose` entry there and calls the service; it never touches R2. See [`docs/modules/files.md`](../modules/files.md). |
| Public (credential-less) reads | `GET /files/:id`, mounted **outside `/v1`** alongside `/webhooks` and `/oauth/google`. Serves only purposes whose policy sets `publiclyReadable` — `quote_logo` alone in v1. S9/S11 extend the policy table, not the read path. |
| Tenant timezone | **Does not exist anywhere in `src/`.** S10 needs it (C6). |
| `is_internal` on ticket messages | **Does not exist.** S11 adds it, and must default it correctly — PRD-005 calls leaking an internal note the failure mode that would kill trust in the module. |
| Event registry | `src/schemas/events/registry.ts`, one Zod file per event, mapped `event_type → latest schema`. Unknown types are rejected by the consumer. |
| Event consumer | `processEvent()` in `src/queue/consumer.ts`: validate → append to `events_log` → route to agent. `AGENT_ROUTES` is the per-type routing map. New consumers hook in here. |
| Roles | `src/auth/roles.ts` — `admin`, `operator`, `finance`, `support`, `readonly`, `employee`. PRD-008 shipped the decision: a **capability matrix** (`src/auth/capabilities.ts`) enforced for every `/v1` route by the mount table in `src/index.ts`, plus the self-service `employee` tier. Adding a role means editing `roles.ts` + the matrix + `ui/src/lib/roles.ts` — **no migration** (0022 dropped the `users.role` CHECK). PRD-000's role-based strategy (`admin` or `finance`) is implemented in `src/modules/approvals/resolver.ts`. See [`docs/architecture/roles-and-permissions.md`](../architecture/roles-and-permissions.md). |
| Reporting lines | `employees.manager_employee_id`, self-referencing FK, cycles rejected by `assertNoManagerCycle` walking the ancestor chain. `employees.user_id` is **nullable** — see C1. |
| Leave | `src/modules/people/leave/` (S7, `0026`) — `leave_requests` only. **Balance is derived, never stored**, so approving does not decrement anything. `src/modules/people/leave/policy-port.ts` is the **S6 seam**: it reads S6's `leave_types` / `leave_balances` / `public_holidays` / work week and falls back to provisional defaults when they are unreadable, warning once with a `[leave/policy-port]` prefix. **S6's closing task is to reconcile that one file and delete the fallbacks** — its queries are a reading of PRD-006's wording, not a schema S6 agreed to. See [`docs/modules/leave.md`](../modules/leave.md). |
| Subject-module reaction to an approval decision | An **event consumer**, not a hook in the approvals primitive. `applyLeaveDecision` (S7) sits beside `fanoutNotifications` in `processEvent` and dispatches on `subject_type`. Safe for leave because a missed transition cannot corrupt a derived balance; **not** safe for S5's ledger posting, which PRD-006 requires be atomic with the decision. S5 needs a different mechanism and should not copy this one. |
| 409 state-machine convention | `src/modules/support/state-machine.ts` and `SupportError(httpStatus: 404 \| 409)`. Approvals must match this shape; so must PRD-004's immutability 409s and PRD-006's approved-claim 409. |
| Quote branding | A `quote_branding` table **already exists** (`0013_quotes.sql`). S9 extends it rather than starting fresh. |
| Gmail client | `src/integrations/google/gmail-client.ts` — `getMessage()` is metadata-only with four headers; `sendMessage()` accepts `threadId`. See the resolved PRD-005 question. |
| LLM ports | `src/llm/anthropic.ts` (`DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8"`), `src/llm/openai.ts`. Agent lives in `src/agents/collections.ts` + `decision.ts`. |
| Tests | `@cloudflare/vitest-pool-workers`, real Workers runtime, flat files in `test/`. `vitest.config.ts` points at `wrangler.jsonc`, so **a new binding must be in `wrangler.jsonc` or tests cannot see it.** |
| Test storage isolation | **Isolated storage is on**: D1 writes made inside an `it` are rolled back before the next test, so one test cannot rely on rows another created. Seed shared fixtures in `beforeAll`, which does persist for the file. Cost S1 three confusing failures against correct code — the endpoint worked in isolation while the suite reported missing rows. |
| Console dependencies | `ui/` has its **own** `package.json` and `node_modules`, separate from the root. `npm ci` at the root does not install them, and without them a console typecheck reports every import as missing — which looks like a broken change and is not. |
| Console | Vite + React under `ui/src`; pages per module, shared `ui/src/components`, modals in `ui/src/components/modals`. |

---

## Session briefs

---

### S1 — PRD-001a: Ledger dimensions + profitability

**PRD:** [001](PRD-001-finance-ledger-completeness.md) §§ "Ledger dimensions",
"Profitability rollups in Insights" · **Branch:** `claude/prd-001a-ledger-dimensions`

**Scope:** dimensions and the profitability rollup. Tax, credit notes and
multi-currency are S12/S13 — explicitly out.

Why first: this alters the shape of the append-only ledger, and PRD-001 is blunt
about the window — *"every day of real customer data makes this migration more
expensive and less backfillable."*

**Deliverables**

- Nullable columns on the journal **line** table: `customer_id`, `project_id`,
  `department_code`, `employee_id`, `cost_centre` (free text, reserved). All
  nullable, so existing entries stay valid and no backfill is needed.
- `department_code` validates against the existing 11-department taxonomy.
- Auto-derivation where possible: invoice postings inherit `customer_id`;
  project-linked entries inherit `project_id`. (Claim postings inherit
  `employee_id`/`department_code` in S5.)
- Manual journal entries accept dimensions via API and console.
- **Dimensions immutable once posted**, enforced by SQL trigger — the same
  mechanism as append-only. Correcting a mis-tag is a reversal plus a re-post.
- Indexes on `(tenant_id, project_id)` and `(tenant_id, customer_id)`.
- `GET /v1/insights/profitability?group_by=project|customer|department` →
  revenue, direct cost, margin, margin %. Read-only SQL, no new write path.
  Console: a Profitability view on the Insights page.

**Acceptance criteria → tests:** all five dimension criteria plus both rollup
criteria. The "Unallocated" bucket matters — untagged entries must appear
explicitly, never be silently dropped.

**Blocked sub-decision:** the definition of "direct cost" (see Blocking
decisions). Deliver revenue-side and expense-side rollups; do not build
time-based costing.

**Regression net:** `test/finance-ledger.test.ts`,
`test/ledger-entries.test.ts`, `test/finance-lifecycle.test.ts`,
`test/finance-service.test.ts` must pass **unmodified** — PRD-001's own success
metric.

---

### S2 — PRD-000a: File storage

**PRD:** [000](PRD-000-platform-foundations.md) § "P0 — File storage" ·
**Branch:** `claude/prd-000a-file-storage`

**Read C3 before planning.** It changes the shape of this session.

**Deliverables**

- R2 bucket in **both** wrangler configs; binding added to `src/env.ts`. Tests
  read `wrangler.jsonc`, so it must be there.
- `files` table: `id, tenant_id, key, filename, content_type, size_bytes,
  sha256, uploaded_by, created_at, purpose` plus a soft-delete column.
  `purpose ∈ {quote_logo, claim_receipt, signature, other}`.
- **Per-purpose policy** (C3): max bytes, allowed content types, publicly
  readable. PRD-000's 10 MB / `image/png` + `image/jpeg` + `image/webp` +
  `application/pdf` is the default; `quote_logo` is 2 MB and the only publicly
  readable purpose in v1.
- `POST /v1/files` multipart → file id. `GET /v1/files/:id` streams.
  `DELETE /v1/files/:id` soft-deletes the row and deletes the R2 object.
- Object key **must** be `{tenant_id}/{uuid}`, and the handler **must** verify
  the row's `tenant_id` against the caller before streaming. Never trust the key
  alone.
- Store SHA-256 of content — S9 needs it for signature integrity.

**Acceptance criteria → tests** (`test/files.test.ts`): tenant B fetching tenant
A's file id gets **404, not 403** (do not confirm existence); 12 MB → 413 with a
clear message; `application/zip` → 415; deleted file → 404 *and* the R2 object
is gone. Add: a `quote_logo` is readable unauthenticated while every other
purpose is not.

**Not in scope:** file versioning — uploads are immutable, a new file is a new
object.

**Shipped (S2, `0021_files.sql`).** All of the above, as specified. Details
live in [`docs/modules/files.md`](../modules/files.md); what later sessions
need to know:

- Call `src/modules/files/service.ts` — never R2 directly. A new purpose is an
  entry in `policy.ts` plus a value in the enum, **no migration**.
- Public reads are `GET /files/:id`, **outside `/v1`**, purpose-gated. S9 gets
  the public logo read for free; S11 adds a purpose rather than a route.
- Column names diverge slightly from the brief's shorthand: `file_id` (not
  `id`) and `r2_key` (not `key`), matching the codebase's `<entity>_id`
  convention and the composite `PRIMARY KEY (tenant_id, file_id)`.
- `quote_logo` allows png/jpeg/webp only — PDF is dropped for the one purpose
  served to an unauthenticated caller, since it cannot render in an `<img>`
  anyway.
- Two test-harness traps, both hit during S2: an R2 `get()` in a test leaves an
  unread body stream and breaks the isolated-storage teardown (use `head()`),
  and a `FormData` request body carries no `Content-Length` in the test
  runtime.

---

### S3 — PRD-000b: Approvals primitive

**PRD:** [000](PRD-000-platform-foundations.md) § "P0 — Approvals primitive" ·
**Branch:** `claude/prd-000b-approvals` · **Depends on:** S2

**Read C1, C5 and C8 before planning.**

**Deliverables**

- `approvals` table: `id, tenant_id, subject_type, subject_id, requested_by,
  approver_user_id, state (pending|approved|rejected|cancelled),
  decision_comment, decided_by, decided_at, created_at, idempotency_key`. Rows
  independent, so `sequence_index`/`parent_id` stay additive.
- **`subject_type` as plain `TEXT` validated by a Zod enum in the service, not a
  SQL `CHECK`.** PRD-000's success metric requires dependent PRDs to add a
  `subject_type` value with *zero schema additions*; a `CHECK` constraint would
  force a migration per consuming module. State the divergence in the migration
  comment — the codebase does use `CHECK` elsewhere (e.g.
  `employees.employment_type`), so this is deliberate. Reserve `invoice` per C5.
- Internal service API: `requestApproval(subject)`, `decide(approvalId,
  decision, comment)`, `cancel(approvalId)`. **Not HTTP** — modules call the
  service.
- HTTP: `GET /v1/approvals?state=pending&mine=true`,
  `POST /v1/approvals/:id/approve`, `POST /v1/approvals/:id/reject`.
- Pluggable resolution **per `subject_type`**. Default strategy is the single
  upward walk from C1. Quote/invoice uses role-based (`admin` or `finance`).
- Register the three `approval.*.v1` events with Zod schemas.
- Decisions **terminal**: re-deciding returns 409 with the current state,
  matching `src/modules/support/state-machine.ts`.
- Self-approval blocked unless the approver holds `admin`.

**Acceptance criteria → tests** (`test/approvals.test.ts`): all six PRD criteria,
plus manager-with-no-login walks up the chain (C1), plus multi-level walk
terminating at admin.

**Do not deploy S3 without S4.** An approvals backend nobody can see is not a
feature — PRD-007 exists because that is how approval features die.

**Shipped (S3, `0022_approvals.sql`).** All of the above, as specified. Details
live in [`docs/modules/approvals.md`](../modules/approvals.md); what S4 and the
consuming sessions need to know:

- Call `src/modules/approvals/service.ts` — `requestApproval` / `decide` /
  `cancel` / `cancelForSubject`. A new subject type is a value in
  `subjectTypeSchema` plus a line in `SUBJECT_STRATEGIES`, **no migration**, as
  PRD-000's success metric requires.
- **Resolution is one function**, `resolveApprover` in `resolution.ts`, per C1.
  Order of resort: the subject type's strategy → a tenant admin who is not the
  requester → the requester themselves *only if they hold admin* → 422
  `no_approver` with **no row written**. S14's "no owner set → tenant admin"
  fallback should reuse this shape rather than reinvent it.
- **The solo-admin decision** (new, needed by the walk): a tenant whose only
  active admin is the requester routes the request back to them. PRD-000 permits
  self-approval for admins, and 422-ing would make claims and leave unusable for
  a one-person finance function. Recorded here so S5/S7 do not re-open it.
- `source_module` is **`platform`**, a value added to `sourceModuleSchema` this
  session for primitives belonging to no business module. `events_log
  .source_module` has no `CHECK`, so it needed no migration. S4's notification
  events should use it too.
- Wire event types are **unversioned** (`approval.requested`) while the schema
  files carry `.v1` — the existing registry convention, and the envelope's
  `<entity>.<action>` regex enforces it. There is deliberately **no
  `approval.cancelled`**: cancellation happens because the subject went away and
  the subject module emits its own event.
- Every `approval.*` payload carries **both** `requested_by` and
  `approver_user_id`, so S4's consumer never needs a DB lookup to know who to
  notify. `approval.requested` also carries `resolution_strategy` /
  `resolution_hops`.
- **Two deliberate divergences from PRD-000's letter**, both for S4 to inherit
  rather than re-litigate: `reject` does **not** require a comment at the API
  (PRD-000 says optional; PRD-007's console enforces it client-side), and a
  fourth route `POST /v1/approvals/:id/cancel` exists — requester-or-admin only
  — because PRD-007's My requests tab needs it and the generic inbox cannot know
  which subject module owns a row.
- A **tenant API key cannot decide** (400): it authenticates a tenant, not a
  person, so there is nobody to write into `decided_by`. Tests that need a
  decision must use a cookie session.
- Test-harness note: the test env has a real `EVENTS` queue binding, so a sent
  envelope never reaches the consumer and **nothing lands in `events_log`**.
  `test/approvals.test.ts` uses a capturing bus to assert emissions and
  `ensureEventBus` on a stripped env for the one end-to-end check. S4 will want
  the same two patterns.
- **Baseline after S3:** clean typecheck, 39 test files / 406 tests. (S2's
  recorded baseline of 38 / 346 was already stale by the time S3 ran — `main`
  was at 38 / 361. Re-measure, per standing rule 5.)

---

### S4 — PRD-000c + PRD-007: Notifications & inbox shell

**PRDs:** [000](PRD-000-platform-foundations.md) § "P0 — Notifications" and all
of [007](PRD-007-console-approvals-inbox.md) · **Branch:**
`claude/prd-000c-007-notifications-inbox` · **Depends on:** S3

**Read C4 and C5 before planning.** This is the largest session in the plan;
if it must be split, the seam is backend (notifications API + consumer) versus
console (bell + inbox).

**Backend**

- `notifications` table: `id, tenant_id, user_id, type, subject_type,
  subject_id, title, body, read_at, created_at`.
- Rows created by an **event consumer**, never module code. Consumes the three
  `approval.*.v1` events plus `approval.nudged.v1` (C4), hooked into
  `processEvent`. New types extend the event→notification map.
- `GET /v1/notifications?unread=true`, `POST /v1/notifications/:id/read`,
  `POST /v1/notifications/read-all`.
- Idempotent insert on a natural key, cheap, non-throwing — see the resolved
  free-plan question.

**Console**

- Header bell with unread count on every page; dropdown grouped by type, each
  item deep-linking to its subject; mark-on-click and mark-all-read; poll on
  route change and every 60s **only while the tab is focused**; a useful empty
  state. Decide the `subject_type → console route` map here, next to the router
  — not in the API payload, or the backend ends up owning frontend routes.
- `/approvals` with tabs **Awaiting me** (default), **My requests**, **History**.
  Oldest first, age prominent.
- **Type-specific renderer registry.** The shell is generic; each `subject_type`
  registers a card. **S4 ships the registry, the generic fallback card, and no
  type-specific renderers** — leave and claim cards ship with S5/S7, the quote
  card with S9, and no invoice card is built (C5).
- Approve/Reject inline with optional comment; **reject requires a comment**.
  Optimistic update with rollback, matching the existing deals stage-move
  pattern. Filters by type and requester.
- My requests: state, approver name, time waiting; **nudge** (one notification,
  second nudge within 24h blocked — C4); cancel own pending requests.
- **Mobile: `/approvals` and the bell fully usable at 375px.** Cards stack,
  images tappable to full screen, large touch targets. PRD-007 is explicit that
  this is the *only* part of the console with a hard mobile requirement.
- "Needs your attention" tile on the existing dashboard, inside the existing KPI
  tile layout.

**Acceptance criteria → tests:** PRD-000's four notification criteria — including
**notification creation on the inline fallback path** (pattern:
`test/direct-event-bus.test.ts`) and tenant B never seeing tenant A's rows —
plus PRD-007's bell, inbox, requester and mobile criteria. Two are easy to miss:
polling pauses in a background tab, and a `subject_type` with no registered
renderer falls back rather than crashing.

**Shipped (S4, `0023_notifications.sql`).** All of the above, as specified,
including the nudge. Details live in
[`docs/modules/notifications.md`](../modules/notifications.md); what the
consuming sessions need to know:

- **Only the consumer writes `notifications`.** Add a mapper entry to
  `NOTIFICATION_MAP` in `src/modules/notifications/consumer.ts` — that is the
  designed way to add a type (standing rule 2). S11 and S14 both have entries to
  add.
- **Put the recipient on your event payload.** The consumer must not query D1 to
  compose a row: on the free plan it runs inline with the emitting request. S3's
  `approval.*` payloads carry both parties for exactly this reason.
- **`dedupe_key` semantics matter.** Key a one-off on the subject
  (`approval.requested:<approval_id>`); key a *repeatable* act on
  `envelope.event_id` (`approval.nudged:<event_id>`), or the second legitimate
  occurrence is silently swallowed by the unique index.
- **The consumer never throws** — every failure degrades to "no row, one log
  line". A test asserting that a bad payload rejects will fail; the contract is
  the opposite.
- **The nudge cooldown has its own table**, `approval_nudges`, not a column on
  `approvals` and not derived from `notifications` (the notification row is
  written asynchronously on the paid plan, so deriving it would let a second
  nudge through). Requester-only, no admin override.
- **`GET /v1/meta/users`** was added for requester/approver names — see the
  codebase-facts table.
- **Two PRD-007 decisions taken deliberately:** high-value approvals do **not**
  require re-authentication in v1 (PRD-007 asks for a deliberate choice rather
  than one by omission), and the "Needs your attention" dashboard tile counts
  approvals only — not overdue invoices or breached SLAs, which PRD-007 flags as
  a risk of becoming a second dashboard.
- **Known gap, not covered by tests:** PRD-007's two mobile criteria are visual
  and jsdom has no layout engine, so the tests pin the responsive *contract* (no
  fixed widths, stacked full-width controls, 40px targets) rather than measuring
  overflow at 375px. `/approvals` and the bell want one manual pass in a narrow
  viewport before this is called done.
- **Baseline after S4:** clean typecheck, 42 test files / 476 tests in the
  Workers suite; 12 files / 88 tests in `ui/`.

**Not in scope:** WebSockets/DO fanout, mobile push, email fanout (P1),
notification preferences (P1), bulk approve (P1), keyboard shortcuts (P1),
delegation (P1), multi-step chains (P2), approve-by-email (P2).

---

### S5 — PRD-006a: Expense claims + GL posting

**PRD:** [006](PRD-006-people-leave-and-claims.md) §§ "Claims: submission",
"Claims: approval and GL posting" · **Branch:** `claude/prd-006a-expense-claims`
· **Depends on:** S1, S2, S4

**Read C2 before planning** — the SST Input leg is out of scope here.

The architecture-proving session: claim → GL → cash position → project margin.
PRD-006 is direct about why it matters — *"no standalone HR product can do that,
because they do not own the books. That is the demo."*

**Deliverables**

- `expense_claims`: employee, claim date, category, description, amount,
  currency, tax amount, **receipt image required** (S2, `purpose =
  claim_receipt`), optional project and department. Multi-line claims. Mileage
  as distance × per-km rate. Per-category limits, warn on breach without
  blocking.
- Claim categories per tenant, **each mapped to a GL expense account** — that
  mapping is what makes posting possible.
- Approval via the S3 primitive, new `subject_type` value, **no new approval
  table and no module-local notifications** (standing rule 2).
- On approval, post **Dr {category expense} / Cr Employee Reimbursements
  Payable** with `employee_id`, `project_id`, `department_code` dimensions from
  S1. Add `Employee Reimbursements Payable` to the seeded chart of accounts.
- On reimbursement: **Dr Employee Reimbursements Payable / Cr Cash**, recorded
  as a payment against the claim. Unpaid approved claims appear as a liability
  and in the cash-flow outlook.
- Rejection returns the claim with a comment; resubmission allowed (C8).
- The claim renderer for S4's inbox registry — **receipt image inline and
  zoomable**, category, amount, project, limit status, line breakdown.
- Events: `claim.submitted.v1`, `claim.approved.v1`, `claim.rejected.v1`,
  `claim.paid.v1`.

**Acceptance criteria → tests:** all four submission criteria and all six
posting criteria. The load-bearing one is **atomicity** — no approved claim
without its journal entry. Also: an approved claim is immutable (409), because
it has hit the ledger.

**Shipped (S5, `0024_expense_claims.sql`).** All of the above, as specified,
including the SST leg being left out per C2. Details live in
[`docs/modules/claims.md`](../modules/claims.md); what later sessions need to
know:

- **The primitive gained a decision-effect hook, and S7 should use it.**
  PRD-006's atomicity criterion cannot be met by consuming `approval.approved`:
  that consumer runs after the decision has committed, and the free-plan inline
  bus catches and *drops* a thrower. So `src/modules/approvals/decision-effects.ts`
  lets a subject type contribute statements to the **same `db.batch()`** as the
  `approvals` UPDATE. An effect that throws writes nothing at all. Adding one is
  a line in that map plus one function in the consuming module — and that
  function must not import `approvals/service`, or it is a cycle.
- **Four things S2/S3/S4 had already provided were not re-added:**
  `expense_claim` was already in `subjectTypeSchema` and already mapped to
  `manager_chain`; `claim_receipt` was already a file purpose; the `approval.*`
  notification mappers already satisfy "the manager has a notification" and "the
  employee is notified". **No `claim.*` entry was added to `NOTIFICATION_MAP`** —
  it would put two rows in one bell for one submission.
- **Claims are on the `self` capability axis**, like approvals and notifications,
  because the `employee` tier holds `self` + `meta` and nothing else and is
  exactly who files a claim. Visibility is per row: owner, *or* the approver on
  one of its approvals, *or* `finance:read`. Anything else is a **404, not a
  403**. `POST /v1/claims/:id/reimburse` and the category writes carry
  `finance:write` on the route.
- **Receipts needed two purpose-locked routes** — `POST /v1/claims/receipts` and
  `GET /v1/claims/:id/lines/:n/receipt` — because `/v1/files` is gated on the
  `files` module and the `employee` tier holds none of it. Both go through the
  files primitive, never R2; the upload forces `purpose = claim_receipt` and the
  read authorises on the claim. S7's leave attachments will hit this same wall.
- **`2100 Employee Reimbursements Payable` joined `SYSTEM_ACCOUNTS`.** That
  changed the seeded chart, so `test/finance-ledger.test.ts` has two updated
  assertions — the only change to a regression-net file. The five `5xxx` category
  expense accounts are seeded by the claims module with `is_system = 0` instead.
- **Postings are `source_type = 'manual'` with `source_id = clm_…`.** Adding a
  `'claim'` source type needs a CHECK rebuild of `journal_entries`, which
  `journal_lines`' FK plus its append-only `RAISE(ABORT)` trigger make
  unavailable (0022's migration documents all four failed pragmas). **S12/S13
  should spend one reviewed rebuild on the whole vocabulary** rather than each
  smuggling a trigger drop into an unrelated session.
- **`subjectRoutes.ts` now maps `expense_claim`**, because S5 shipped a read-only
  `/claims/:id` screen alongside the card. Filing from the console stays P1.
- **Console receipts are fetched, not `<img src>`-ed.** The session cookie is
  `SameSite=Lax`, so a cross-origin subresource request carries no credential.
  `ApiClient.getBlob()` was added for this; S7's attachment preview wants it too.
- **Test-harness trap, new and worth knowing:** the Workers test env has a real
  EVENTS queue binding and the runtime delivers those messages *after* the
  request that sent them — i.e. after the `it`. The consumer touches D1, which
  breaks isolated-storage teardown with "Failed to pop isolated storage stack
  frame". `test/claims-fixture.ts` hands the Worker an env whose EVENTS is a
  recording sink. Any suite whose last test ends on an approval needs the same.
- **Baseline after S5:** clean typecheck, 48 test files / 834 tests in the
  Workers suite; 14 files / 122 tests in `ui/`.

---

### S6 — PRD-006b: Leave policy, holidays, balances

**PRD:** [006](PRD-006-people-leave-and-claims.md) §§ "Leave: policy and
entitlement", "Leave: public holidays" · **Branch:** `claude/prd-006b-leave-policy`
· **Depends on:** S4

**Deliverables**

- `leave_types` per tenant: paid/unpaid, requires-attachment (medical
  certificates), max consecutive days, allows-half-day, carry-forward rules.
  Seed Malaysian defaults — annual, sick, hospitalisation, maternity,
  paternity, unpaid, compassionate — **all editable, none hardcoded.**
- `leave_policies`: entitlement by employment type and tenure band, with accrual
  method `annual_upfront | monthly_accrual | on_anniversary`. Employee
  assignment; pro-rating for mid-year joiners and leavers.
- `leave_balances` derived from entitlement + carry-forward − taken − pending.
  **Pending requests must reduce available balance** or employees over-book.
- `public_holidays`: date, name, scope (`national` | state code), tenant
  overrides. **State variation matters** — Selangor, Penang and Sarawak differ
  and an office manager notices on day one. Employee work location/state drives
  which set applies.
- Configurable work week — default Mon–Fri, but Kelantan and Terengganu run
  Sun–Thu and some tenants run Saturday half-days.
- Employment Act minimums are a **seed default and a warning, not an enforced
  floor** — a tenant may have contractual terms above minimum and the system
  must not fight them.

**Acceptance criteria → tests:** all five entitlement criteria and all three
holiday criteria. PRD-006's success metric is explicit that balance correctness
across mid-year joins, carry-forward and state holidays must be covered by tests,
*"because a wrong balance destroys trust permanently."*

**Decide before starting:** the public-holiday data source (see Blocking
decisions).

**Shipped (S6, `0025_leave_policy.sql`).** All of the above. Details live in
[`docs/modules/leave.md`](../modules/leave.md); what S7 and later sessions need
to know:

- **`leave_requests` already exists.** S6 created it — not scope creep, but
  because two of S6's acceptance criteria (pending reduces the balance, rejected
  restores it) are *about* it, and a balance defined as
  `entitlement − taken − pending` cannot be built without the thing being
  consumed. It carries the balance-relevant columns only: `employee_id`,
  `leave_type_id`, `start_date`, `end_date`, `start_half_day`, `end_half_day`,
  `working_days`, `state` (`pending|approved|rejected|cancelled`). **S7 adds
  `reason`, `attachment_file_id`, the approval linkage and the state machine
  additively**, and registers the four `leave.*` events. S6 ships no request
  write path at all; its tests insert rows through `env.DB`.
- **Call `getBalances()` and `countWorkingDays()`, do not re-derive them.**
  `src/modules/leave/balances.ts` and `workdays.ts` already answer "how many
  working days is this range for this employee" and "what is left" — S7's
  pre-submission preview and its over-balance block are both those two
  functions. `GET /v1/me/leave/working-days` is the preview endpoint already.
- **`working_days` is stored at submission, deliberately**, so a later holiday
  correction cannot restate a request somebody already approved. S7 should
  compute it once and write it, not recompute on read.
- **Public holidays are an overlay, not rows.** The shipped calendar lives in
  `src/modules/leave/holidays/data.ts` and is never written to D1;
  `public_holidays` holds tenant deltas only. Adding a year is a code change, no
  migration. S10's "no contact on Malaysian public holidays" guardrail should
  reuse `effectiveHolidays()` rather than building a second holiday source, as
  the S10 brief anticipates.
- **A missing holiday year is reported, never silent.** Responses carry
  `holiday_data_available` and `holiday_data_provisional`; an unshipped year
  returns `false` rather than an empty list that reads as "no holidays".
- **Statutory minimums warn and never block** — no CHECK, no rejection. Policy
  writes return 201/200 with the value as entered plus a `warnings` array.
  Do not "fix" this into validation.
- **Two capability axes, as PRD-008 intended:** HR administration on
  `/v1/people/leave/*` (`people:read`/`people:write`, so `finance`, `support`
  and the `employee` tier 403), self-service on `/v1/me/leave/*` (`self`, so the
  `employee` tier reads its own balance with no business access). Year-close is
  raised to `admin:write`.
- **Leave year is the calendar year** (confirmed with Chris/Josh: Malaysian
  companies refresh annual entitlement yearly). `on_anniversary` policies run on
  the employee's own year. No fiscal-year cycle — add one only if a design
  partner needs it.
- **No console.** Leave configuration is API-only until S7 builds the leave
  screens; S7 owns the `leave_request` renderer for S4's registry.
- **Baseline after S6:** clean typecheck, 48 test files / 835 tests in the
  Workers suite (S6 added 3 files / 86 tests to a `main` measured at 45 / 749,
  which was already well past the 42 / 476 recorded for S4 — re-measure, per
  standing rule 5). `ui/` untouched.

---

### S7 — PRD-006c: Leave requests, approval, team calendar

**PRD:** [006](PRD-006-people-leave-and-claims.md) § "Leave: request and
approval" · **Branch:** `claude/prd-006c-leave-requests` · **Depends on:** S6

**Deliverables**

- Request: type, start/end with half-day support, reason, optional attachment
  (S2), **computed working days shown before submission**.
- Routes to the manager via the S3 primitive — which, per C1, walks up the chain
  and falls back to admin.
- Employee may cancel while pending; cancelling **approved future** leave needs
  re-approval or admin action. Cancellation exercises PRD-000's *"cancelled
  subject no longer appears in pending lists"* criterion.
- Team calendar: who is off, by team and by month. PRD-006 calls this the
  feature managers actually use.
- Overlap warning against another team member's approved leave — **warn, do not
  block**. Overlap with the *same* employee's existing request is a 409.
- The leave renderer for S4's registry: employee, type, dates, working days,
  **remaining balance after approval**, overlapping team leave, reason,
  attachment.
- Events: `leave.requested.v1`, `leave.approved.v1`, `leave.rejected.v1`,
  `leave.cancelled.v1`.

**Time-box this.** The index flags how leave policies actually work as a *shaped*
guess rather than a structural certainty — build the minimum that works and let
the first design partner correct it.

**Shipped (S7, `0026_leave_requests.sql`).** All of the above. Details live in
[`docs/modules/leave.md`](../modules/leave.md); what the next session needs to
know is here.

- **Migration `0026`, not `0024`.** See footnote ⁶ — three sessions were live at
  once and the numbers are reserved by session order.
- **S6 had not landed, so the dependency is a seam, not an import.**
  Everything S7 needs from S6 goes through one file,
  `src/modules/people/leave/policy-port.ts`, which reads S6's tables and falls
  back to provisional defaults when they are unreadable. **S6's closing task is to
  reconcile that file and delete the fallbacks** — the reconciliation checklist is
  in the module doc. `leave_requests.leave_type_code` is a code, not an FK to
  `leave_types`, so the two migrations are order-independent.
- **Balance is derived, and approval does not mutate it.** `pending` and
  `approved` both consume availability, so a pending→approved transition leaves
  `available` unchanged. That is why the decision arrives via an event consumer
  (standing rule 2) rather than a synchronous hook into the S3 primitive — there
  is no decrement to lose. **S5 must not copy this**: a journal entry is a real
  side effect and PRD-006 requires it be atomic with the decision, so claims need
  something S7 deliberately did not build. **The approvals primitive was not
  modified by S7**, which also kept the conflict surface with concurrent S5 at
  zero.
- **Mounted at `/v1/leave` on the `self` module, not `/v1/me/leave`.** The module
  is what PRD-006/PRD-008 actually require (an `employee` login with no business
  capability can file and track leave). The path diverges because a leave request
  must be readable by its *approver*, who is not "me", and `me.ts` holds "you can
  only ever read your own record" as an invariant. Authorization is per-row:
  the subject employee, anyone holding an approval on that one row, a
  `people:read` holder, or an admin. The per-row-approval clause is what makes the
  inbox card work for a team lead on the self-service tier.
- **One new state, `cancellation_pending`**, to implement PRD-006's "cancelling an
  approved future leave requires re-approval or admin action" literally. The
  decision handler distinguishes the two meanings of one `approval.approved` by
  the state it finds the request in, so no extra column. Cancelling approved leave
  that has already started is a 409.
- **Exactly one `NOTIFICATION_MAP` entry** (`leave.cancelled`). S4's `approval.*`
  mappers already cover submission and decisions; the gap was an admin cancelling
  somebody's approved leave, which involves no approval decision and so had no
  event to notify on. `test/notification-consumer.test.ts` pins the expected set —
  S11 and S14 will each need to update that assertion.
- **`leave_attachment` is a new `files` purpose** (code only, no migration) and is
  never publicly readable — it holds medical certificates.
- **Baseline after S7:** clean typecheck, 48 files / 844 tests (Workers) and
  13 files / 110 tests (`ui/`). `main` measured 45 / 749 before this work.

---

### S8 — PRD-003: Contact roles, then attributes and health

**PRD:** [003](PRD-003-crm-depth.md) · **Branch:** `claude/prd-003-crm-depth` ·
**Depends on:** S1 (loosely — health works on existing data and improves with
dimensions)

**Read C7:** `payment_terms_days` changes invoice due-date computation, so this
session touches finance.

PRD-003's own guidance is *"do roles first, ship it, then decide whether
attributes and health are still the right next thing."* Roles are the must-land
part — they unblock S9's signatory and improve S10's targeting. If the session
runs long, attributes and health become S8b rather than being rushed.

**Roles (must land)**

- Multi-valued `roles` on contacts from `primary`, `billing`, `technical`,
  `signatory`, `other`. Exactly one `is_primary` per customer, enforced.
- `resolveContact(customerId, role)` with a documented fallback chain:
  requested role → primary → any contact. Used by the CollectionsAgent, invoice
  delivery and quote signing.
- Existing contacts migrate to `primary` on the earliest by `created_at`,
  `other` on the rest — a safe default, not a guess at intent.
- `customer.no_contact.v1` when dispatch finds zero contacts — fail gracefully,
  do not throw.

**Attributes and health (same session if there is room)**

- `registration_no` (SSM), `tax_id`, `industry`, `website`,
  `payment_terms_days`, `credit_limit_cents`, structured `billing_address` and
  `shipping_address`, `preferred_channel`, `notes`.
- Health **derived, not stored** — computed on read from DSO vs terms, overdue
  invoice count/age, open ticket count/age, last activity recency, open deal
  value. Output a band (`good`/`watch`/`at_risk`) **plus the contributing
  reasons**; PRD-003 is explicit that reasons matter more than the score. Budget:
  no more than one extra query on the customer detail endpoint.

**Decide before building health:** whether `at_risk` auto-pauses outbound sales
(see Blocking decisions). Recommendation is signal-only in v1.

**Explicitly not in scope:** custom fields, duplicate detection/merge, email
sequencing, company hierarchy, Apollo-style enrichment.

---

### S9 — PRD-004: Quote branding & click-to-sign

**PRD:** [004](PRD-004-quote-branding-and-signing.md) · **Branch:**
`claude/prd-004-quote-signing` · **Depends on:** S2, S8; S3 only for the P1
internal sign-off

Closes quote-to-cash. PRD-004's suggested internal order: **immutability rules →
public link → acceptance + audit → logo → internal sign-off.** The immutability
and public-link work needs no file storage, so it can start even if S2 slipped.

**Deliverables (P0)**

- **A quote cannot be edited after being sent** — changes require a new version.
  PRD-004 calls this *"the load-bearing requirement of the whole feature"*: if
  the document can change after signing, the signature is worthless. 409 on
  edit, matching the existing state-machine convention.
- `GET /q/:token` — unauthenticated, token-addressed public view. High-entropy
  token, **not** the quote id, **stored hashed**. Optional expiry aligned to the
  quote's own; expired renders an explanatory state, not a 404. Revocable.
  `quote.viewed.v1` on first view only; later views update `last_viewed_at`.
- Click-to-sign: signatory name and email, optional typed/drawn signature,
  **explicit agreement checkbox**, Accept. Captures an audit record — name,
  email, IP, user agent, UTC timestamp, agreement text version, and the
  **SHA-256 of the rendered document**. The rendered HTML is frozen to file
  storage at acceptance, and the stored hash must match the stored artifact.
  Signature image via S2 (`purpose = signature`).
- Logo via S2 (`purpose = quote_logo`, ≤ 2 MB) referenced from branding
  settings — extend the existing `quote_branding` table. Served on the public
  page **without exposing the tenant's other files** (C3). Optional accent
  colour and footer text.
- Decline with an optional reason → existing `quote.rejected.v1`. Existing cron
  expiry keeps working; expired quotes cannot be accepted.
- If the customer has a `signatory` contact (S8), pre-fill and record the match.
- The quote renderer for S4's inbox registry.

**Acceptance criteria → tests:** all of PRD-004's. The two that carry the feature:
the archived artifact's SHA-256 equals the hash in the acceptance record, and the
**archived artifact renders identically after the tenant changes their branding
settings**. Also rate-limit `/q/:token` — a public endpoint needs abuse
protection distinct from the authenticated API's limits.

**P1 in this PRD, not P0:** internal sign-off above a value threshold (uses the
S3 primitive with `subject_type = quote`), PDF generation, quote versioning UI,
customer reminders.

---

### S10 — PRD-002: Agent guardrails, eval harness, observability

**PRD:** [002](PRD-002-agent-portability-and-eval.md) · **Branch:**
`claude/prd-002-agent-guardrails` · **Depends on:** nothing

**Read C6:** this session must add a tenant timezone setting, and one eval
scenario reaches into S13's credit notes.

Portability is already done. **Guardrails first** — they are the difference
between an agent that is safe to leave running and one that needs supervision,
and PRD-002 wants them in before real customer data.

**Guardrails (enforced in code after the LLM returns, before any send)**

- Contact cooldown 24h per customer (exists — move enforcement into a shared
  guard). Max reminders per invoice, default 5, tenant-configurable.
- **No contact outside 09:00–18:00 tenant local time** — *"a WhatsApp at 2am is
  a product-defining mistake."* **Defer to the next window, never drop.**
  Requires the new tenant timezone setting (C6).
- No contact on Malaysian public holidays or weekends by default,
  tenant-configurable. (Note: S6 builds a `public_holidays` table — if S6 has
  landed, reuse it rather than building a second holiday source.)
- Escalation requires past-due ≥ tenant threshold **and** ≥ 2 prior reminders;
  the model cannot escalate earlier regardless of what it returns.
- Messages must reference a real invoice number present in context — reject and
  fall back on hallucinated references. Hard character cap.
- **Kill switch:** `agents.enabled` per tenant and a per-customer
  `agent_paused`, both checked before any send.
- Every override logs `guardrail.override.v1`.

**Eval harness**

- `evals/` with **25–30 frozen fixture scenarios**, each a full agent context
  plus an expectation. Expectations are **ranges and constraints, not exact
  strings** — LLM output is non-deterministic.
- Cover the failure modes PRD-002 lists, including empty/degenerate context and
  a malformed LLM response falling back deterministically.
- `npm run eval` prints scenario, expected, actual, pass/fail, tokens, latency,
  cost. `npm run eval -- --provider=openai --model=X` for comparisons.
- A **generic runner keyed on an agent's decision function** so the future
  SalesAgent and SupportAgent reuse it.
- Not a blocking CI gate (cost, non-determinism) but a documented pre-merge step
  for any prompt or model change. Commit a baseline result.

**Observability**

- Extend the decision event to record provider, model, prompt version, token
  counts, latency, cost estimate, fallback used, guardrail overrode. This is a
  breaking payload change → `collections.decision.v2`.
- `GET /v1/insights/agents` — decisions by outcome, fallback rate, override
  rate, spend by period. Console: fallback and override badges on the Agent
  Activity feed.

**Decide before starting:** the default escalation threshold in days (see
Blocking decisions).

**Non-negotiable:** nothing here changes the fallback guarantee — collections
never silently stops.

---

### S11 — PRD-005: Support customer-facing intake & tracking

**PRD:** [005](PRD-005-support-intake-and-tracking.md) · **Branch:**
`claude/prd-005-support-intake` · **Depends on:** S2, **S4**

**Read the resolved Gmail question above** — it changes the threading design and
names three concrete pieces of Gmail work.

PRD-005's suggested order: **threading + email-to-ticket → public tracking page
(with the internal-note flag) → assignment/SLA → attachments → public intake
token.**

**Deliverables**

- Email-to-ticket off the existing `email.received` stream. Thread on Gmail
  `thread_id` (already on the event) with the `[#TKT-1234]` subject token as
  fallback. Per-tenant inbox → queue/priority routing. Sender matching to a
  known contact, else unlinked with the raw sender recorded. Reply to a resolved
  ticket re-opens it — **verify that fires on the email path too**. Loop
  protection via `Auto-Submitted`/`Precedence`, and never reply to a no-reply
  address. Idempotent on Gmail message id, because history polling redelivers.
- `POST /public/tickets` behind a **per-tenant public intake token**, distinct
  from the tenant API key and safe to embed in a tenant's frontend. **Scoped to
  ticket creation only** — PRD-005 calls verifying that the security-critical
  test. Rate limited per token and per IP, revocable from Settings.
- `GET /t/:token` — unauthenticated per-ticket tracking page, token hashed at
  rest, showing status, thread and a reply box. Customer replies append as
  `author = customer` and re-open resolved tickets.
- **`is_internal` on ticket messages, defaulted correctly.** Internal notes must
  never reach the public page, and the test asserts on the **API response, not
  just the UI**. PRD-005: leaking an internal note *"is the failure mode that
  would kill trust in the module."*
- `assignee_user_id`; assignment emits `ticket.assigned.v1` and notifies via S4.
  `due_at` from priority-based targets in tenant settings. Cron sweep emits
  `ticket.sla_breached.v1` once, mirroring the invoice overdue sweep.
- Attachments on messages via S2, inbound email attachments where Gmail provides
  them, stricter limits on the public upload path (C3).

**Not in scope:** the SupportAgent — this PRD builds the substrate only. Also
out: live chat, knowledge base, full customer portal, CSAT, business-hours SLA
calendars.

**Watch:** if this session needs scoped API keys rather than a purpose-built
intake token, that is a scope conversation, not a quiet addition —
`docs/design/api-key-management.md` is designed but unbuilt.

---

### S12 — PRD-001b: Tax (SST)

**PRD:** [001](PRD-001-finance-ledger-completeness.md) § "P0 — Tax (SST)" ·
**Branch:** `claude/prd-001b-tax` · **Depends on:** S1

Demand-driven — but **moves ahead of S5 if a design partner is SST-registered**,
because claims posting wants the SST Input leg (C2).

- `tax_rates` per tenant: `code, name, rate_bps, type (sales|service|exempt|zero),
  effective_from, effective_to`. Seed Malaysian defaults, fully editable, **do
  not hardcode rates**.
- Tax at **line level** on invoices and quotes — header-level tax cannot
  represent a mixed-rate invoice. Header total is the sum.
- Invoice posting becomes **Dr AR (gross) / Cr Revenue (net) / Cr SST Payable
  (tax)**. Add `SST Payable` to the seeded chart of accounts.
- Tax amount, rate and code stored on the invoice line so a historical invoice
  is reproducible after a rate change.
- **Rounding: compute per line, round each to the cent, sum.** Document it. Do
  not compute on the header total and allocate back.
- When it lands, add the SST Input leg to S5's claim posting (C2).

**Acceptance criteria → tests:** all four, including that tax and net credits sum
exactly to the AR debit with no rounding drift.

**Before seeding defaults:** confirm current Malaysian SST rates and service-tax
scope. Seed values are a starting point, not advice.

---

### S13 — PRD-001c: Credit notes + ledger multi-currency

**PRD:** [001](PRD-001-finance-ledger-completeness.md) §§ "P0 — Credit notes",
"P0 — Ledger multi-currency" · **Branch:** `claude/prd-001c-credit-notes` ·
**Depends on:** S1, S12

**Credit notes**

- Entity referencing an invoice: line items, reason, lifecycle draft → issued,
  own numbering sequence.
- Issuing posts **Dr Revenue / Dr SST Payable / Cr AR** — a real transaction,
  not a reversal, so both documents stay in the customer's history.
- Partial credits allowed; total credited cannot exceed the invoice total.
- A fully credited invoice moves to `credited` and is **excluded from the
  overdue sweep and from the CollectionsAgent's open-invoice context** — so this
  session touches the agent.
- Emits `credit_note.issued.v1`. Unblocks S10's disputed-invoice eval scenario
  (C6).

**Multi-currency on the line**

- Journal lines store `txn_currency`, `txn_amount_cents`, `fx_rate` alongside
  the functional amount. **Balance enforcement applies to functional amounts
  only.** Rates entered manually per transaction; no rate feed, no revaluation.

**Decide first:** whether `credited` is a distinct invoice state or derived from
credit note totals (see Blocking decisions). Derived is cleaner but complicates
the sweep query.

---

### S14 — PRD-009: Project scheduling & deadline reminders

**PRD:** [009](PRD-009-project-scheduling.md) · **Branch:**
`claude/prd-009-project-scheduling` · **Depends on:** S4

The first session in this plan that came from **outside** the codebase. A beta
user asked for project start/end dates and deadline reminders; `projects` has no
date column at all, and every existing PRD treats a project purely as a cost tag
for profitability. That makes this small but unusually well-evidenced — it is the
only requirement here with a real user behind it.

**Deliverables**

- Nullable `start_date`, `target_end_date`, `actual_end_date`, `owner_user_id` on
  `projects`. `target_end_date` before `start_date` → 400, validated in the
  service. Archiving without an `actual_end_date` stamps the archive date.
- Daily sweep **extending the existing `0 1 * * *` cron**, not a second trigger —
  mirror `src/modules/finance/overdue-sweep.ts`.
- Per-tenant lead times (default 7 days and 1 day), emitting
  `project.deadline_approaching.v1` and `project.overdue.v1`, mapped to
  notification rows by the **S4 consumer** — extending its event→notification map
  is the designed way to add a type, not a new mechanism (standing rule 2).
- No owner set → falls back to a tenant admin, same reasoning as approver
  resolution in C1: never route work to nobody.
- **Once per (project, threshold).** The sweep runs daily; re-notifying every
  morning is how a badge becomes noise.
- `GET /v1/projects?schedule=late|due_soon|on_track|no_date`, plus date columns
  and a late badge in the console. Projects with no target date group under an
  explicit "No date set", never as on-track — the same principle as PRD-001a's
  "Unallocated" bucket.

**Acceptance criteria → tests:** all of PRD-009's, including the idempotency one
(run the sweep twice, assert exactly one notification), the archived-project
silence, the free-plan inline path, and that the PRD-001a profitability figures
are unchanged by this migration.

**Decide before phase 2:** PRD-009's blocking question — who the reminder is for
and how often. The schedule columns are safe to build either way; the wrong
cadence trains people to ignore notifications, which is expensive to undo. Build
phase 1 and the filter, then stop and ask if it is still unanswered.

---

## Unslotted work

**PRD-008 — Roles, Permissions & Employee Self-Service** is in this directory but
has no session number, because it landed after the original eight were sequenced
and slotting it is a real decision rather than a formality:

- It is marked **P0** and describes itself as a security gap, which argues for
  running it early — earlier than S8–S14, all of which are P1.
- Its own header says it **blocks PRD-006 employee self-service**, and PRD-006 is
  S6 and S7. On that reading it belongs *before* S6.
- But S3 and S4 are the P0 foundations everything else consumes, and PRD-008 says
  it "must be designed against PRD-000 (approvals) and PRD-006 (leave & claims) so
  it serves both" — which argues for running it *after* S3/S4 so the approvals
  surface it must protect already exists.

**Suggested position: immediately after S4, before S5.** That satisfies the
design-against-PRD-000 requirement, puts a P0 security gap ahead of all the P1
work, and lands before the self-service it blocks. It would take the next free
session number while running out of numeric order — the session numbers are a
naming convention, not an execution order, and this plan should say so once
rather than renumber eleven sessions that are already referenced in commits and
PRs.

Not done here because it changes the run order for S5 onward, which is Chris's
call. Once decided, add the row to the session map, a brief above, and a prompt to
[`SESSION-PROMPTS.md`](SESSION-PROMPTS.md).

---

## Deliberately not in any session

Named so they do not get built by accident:

- **SalesAgent** — designed, not built. Its own PRD once the CRM substrate settles.
- **SupportAgent** — PRD-005 builds the substrate only.
- **Payroll, EPF/SOCSO/EIS/PCB, statutory submissions** — assessed and rejected
  as an undefensible moat.
- **Apollo-style contact database** — cannot be won; enrichment stays a
  pluggable port.
- **Scoped/rotatable API keys** — designed only
  (`docs/design/api-key-management.md`).
- **Time tracking** — an open question in PRD-001, not a commitment. If
  profitability needs it, that is a separate PRD.
- **A generic workflow engine** — PRD-000 is an approvals table, not BPMN.
- **Full tax filing / SST-02 generation, FX revaluation, period close, fixed
  assets, inventory, bank reconciliation** — all explicitly out of PRD-001.
- **Multi-country leave rules** — Malaysia only; no rules engine for a market
  we are not in.
- **Native mobile app** — responsive web only, and only `/approvals` has a hard
  mobile requirement.
