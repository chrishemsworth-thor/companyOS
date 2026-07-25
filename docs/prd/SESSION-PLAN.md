# PRD 000–007 — Multi-Session Build Plan

**Authored:** 2026-07-25 · **Covers:** PRD-000 through PRD-007
**Source docs:** [`README.md`](README.md) (index & sequencing),
[`PRD-000-platform-foundations.md`](PRD-000-platform-foundations.md)

This file exists because the eight PRDs are being built across **separate Claude
Code sessions**. Each session starts with no memory of the last one, so
everything a session needs to start correctly has to be on disk. This is that
handoff surface: a session map, the codebase facts that are easy to get wrong,
and a self-contained brief per session.

---

## How to run a session

Open a session, name the session ID from the table below, and paste:

> Read `docs/prd/SESSION-PLAN.md` and the session brief for **S<n>**, plus the
> PRD it references. Before writing code, produce an implementation plan
> covering D1 migrations, new/changed endpoints, event types to register in the
> schema registry, and the test files you will add. Confirm the plan before
> implementing. Every acceptance criterion must have a corresponding test in the
> Workers runtime suite.

### Standing rules for every session

These carry over from the PRD index and are non-negotiable:

1. **Do not weaken the append-only ledger guarantees or the multi-tenant
   isolation pattern.** If a requirement seems to need it, stop and ask.
2. **Do not invent an approvals or notifications mechanism inside a module.**
   Everything routes through the PRD-000 primitives.
3. **One session, one branch, one shippable increment.** Do not start the next
   session's scope because there is context left over.
4. `npm run typecheck && npm test` must pass before the push that closes a
   session. No session lands with a red suite. **Baseline at S0:** clean
   typecheck, 36 test files / 305 tests passing on `main` at `d1e5202`. A
   session that finds fewer than 305 passing tests has broken something.
5. Update the **Status** column in this file as part of the closing commit —
   it is the only cross-session progress record.

---

## Session map

Order follows the "Recommended build order" in [`README.md`](README.md), split
so each row is one session's worth of work. Priority is the PRD's own priority;
the ordering reason is why it sits here rather than earlier or later.

| # | Session | PRD | Pri | Branch | Depends on | Status |
|---|---|---|---|---|---|---|
| S0 | Plan & document landing | — | — | `claude/readme-p0-review-78jc3u` | — | **done** |
| S1 | Ledger dimensions | 001a | P0 | `claude/prd-001a-ledger-dimensions` | S0 | not started |
| S2 | File storage primitive | 000a | P0 | `claude/prd-000a-file-storage` | S0 | not started |
| S3 | Approvals primitive | 000b | P0 | `claude/prd-000b-approvals` | S2 | not started |
| S4 | Notifications + approvals inbox | 000c + 007 | P0 | `claude/prd-000c-007-notifications-inbox` | S3 | not started |
| S5 | Expense claims | 006a | P0 | `claude/prd-006a-expense-claims` | S1, S2, S4 | not started |
| S6 | Leave | 006b | P0 | `claude/prd-006b-leave` | S4 | not started |
| S7 | Quote branding & click-to-sign | 004 | P1 | `claude/prd-004-quote-signing` | S2, S3, S8¹ | not started |
| S8 | Contact roles & customer depth | 003 | P1 | `claude/prd-003-contact-roles` | S1 (loose) | not started |
| S9 | Collections agent guardrails | 002 | P1 | `claude/prd-002-agent-guardrails` | — | not started |
| S10 | Support customer-facing intake | 005 | P1 | `claude/prd-005-support-intake` | S2 | not started |
| S11 | Tax & credit notes | 001b | P0² | `claude/prd-001b-tax-credit-notes` | S1 | not started |

¹ S7 needs a signatory contact from S8. The index says S8 (003) *"can be pulled
earlier if it unblocks 004"* — if S7 is reached first, pull S8 forward rather
than inventing a signatory field inside quotes.

² PRD-001 is P0 overall, but the index explicitly defers tax and credit notes
until *"a design partner hits them"*. Treat S11 as demand-driven, not scheduled.

### Why this order

- **S1 first.** Ledger dimensions are a schema change to the append-only
  ledger. Doing it before real customer data exists is the entire reason it
  ranks above the P0 foundations.
- **S2 → S3 → S4 is one PRD split three ways.** PRD-000's own phasing is
  files, then approvals, then notifications. Files are genuinely independent
  and smallest. Approvals and notifications are *not* independent: the PRD says
  "phases 2 and 3 should land together — an approval nobody is told about is
  not a feature." They are still two sessions here because approvals is a large
  surface (table + service + resolution strategies + HTTP + events), but **S3
  must not be deployed without S4 following immediately.** If you can only run
  one more session after S3, run S4.
- **S4 absorbs PRD-007.** The index treats "000 + 007 together" as one
  shippable increment, and the notification consumer and its console bell are
  the same feature seen from two ends.
- **S5 before S6.** Claims prove the cross-module architecture
  (claim → GL → cash position → project margin). Leave is table stakes but
  proves less; it also has the higher share of shaped, guessable requirements.
- **S9 before S10.** Guardrails land before an agent messages a stranger.

---

## Codebase facts a session will get wrong

Verified against `main` at `d1e5202` on 2026-07-25.

| Thing | Reality |
|---|---|
| Migration numbering | Highest is `0019_transactional_email.sql`. **Next free is `0020`.** Note `0015` is already duplicated (`0015_google_accounts.sql`, `0015_people.sql`) — do not add a third collision. |
| `files`, `approvals`, `notifications` tables | **None exist.** Confirmed by scanning every `CREATE TABLE` in `migrations/`. |
| R2 | **No bucket bound in either wrangler config.** S2 must add an `r2_buckets` block to *both* `wrangler.jsonc` and `wrangler.free.jsonc`. R2 has a free tier, so the free-plan deploy is not blocked. |
| Event registry | `src/schemas/events/registry.ts` — one Zod file per event under `src/schemas/events/`, mapped `event_type → latest schema`. Unregistered event types are **rejected** by the consumer, not passed through. |
| Event consumer | `processEvent()` in `src/queue/consumer.ts` does validate → append to `events_log` → route to agent. New consumers hook in here. `AGENT_ROUTES` is the existing per-event-type routing map. |
| Roles | `src/auth/roles.ts` — exactly `admin`, `operator`, `finance`, `support`, `readonly`. PRD-000's role-based approver strategy (`admin` or `finance`) maps cleanly; **do not add roles** without a decision. |
| Reporting lines | `employees.manager_employee_id`, self-reference FK, cycles rejected by `assertNoManagerCycle` walking the ancestor chain (`src/modules/people/service.ts`). Reuse this — do not build a parallel org structure. |
| 409 state-machine convention | `src/modules/support/state-machine.ts` + `SupportError(httpStatus: 404 \| 409)`. PRD-000 says approvals must match this convention; copy the shape. |
| Quote branding | A `quote_branding` table **already exists** (`0013_quotes.sql`). S7 extends it rather than starting fresh. |
| Tests | `@cloudflare/vitest-pool-workers`, tests run in the real Workers runtime, flat files in `test/`. `vitest.config.ts` points at `wrangler.jsonc`, so dev placeholder secrets and bindings come from there — **a new binding must be in `wrangler.jsonc` or tests cannot see it.** |
| Console | Vite + React under `ui/src`, pages per module (`ui/src/pages/{crm,finance,people,quotes,support,build,settings}`), shared `ui/src/components`, modals in `ui/src/components/modals`. |

---

## PRD-000's blocking open question — resolved

> **(Engineering, blocking)** Does the current free-plan inline fallback path
> handle a consumer that writes rows, or is it fire-and-forget?
> Notifications depend on it.

**It handles row writes. Notifications are not blocked.**

`createDirectEventBus` in `src/queue/direct.ts` builds a fake `Queue` whose
`send()` **awaits `processEvent(env, body)`** — the same function the real queue
consumer calls. `processEvent` already writes to D1 on every event (the
`events_log` insert in `logEvent`), and that write works today on the free
plan. A notification consumer that inserts rows behaves identically.

Two caveats S4 must design around, both documented in `src/queue/direct.ts`:

1. **No retry, no DLQ.** On the inline path a throwing consumer is caught,
   logged (`[direct-bus] event processing failed`), and **dropped**. The
   business write that emitted the event has already committed, so a failed
   notification insert means a silently missing notification.
2. **Inline dispatch is synchronous with the request.** A slow consumer adds
   latency directly to the API call that emitted the event.

Consequence for S4: the notification consumer must be cheap and must not throw
on recoverable conditions. Prefer `INSERT OR IGNORE` with a natural key so a
re-delivered event is idempotent rather than duplicated, and so a partial
failure can be re-driven. The PRD's acceptance criterion — *"given the free-plan
inline event fallback, then notification creation still works"* — is testable
directly; `test/direct-event-bus.test.ts` is the existing precedent.

---

## Gaps found while reviewing PRD-000

Raising these now so a session does not discover them mid-implementation. None
change the build order.

1. **A manager may have no console user.** `employees.user_id` is **nullable**
   ("optional console-login link"), but `approvals.approver_user_id` is a
   *user*. So the default strategy — "the employee's manager via existing
   People reporting lines" — can resolve to an employee who cannot log in to
   act on it. PRD-000's acceptance criteria cover *no manager set*, but not
   *manager set with no linked user*.
   **Recommended resolution for S3:** treat "manager without `user_id`" the
   same as "no manager" and continue up the ancestor chain, then fall back to a
   tenant admin. Add an acceptance test for it. Flag to Chris if a different
   behaviour is wanted — this is a product call, but the safe default is not to
   route work to someone who cannot see it.

2. **"Routes to the next level up" needs the walk defined.** The acceptance
   criterion *"given a requester who is also the resolved approver and is not
   admin, then the request routes to the next level up, or to an admin if
   none"* implies an upward walk. Combined with (1), S3 should implement **one**
   resolution walk — ascend `manager_employee_id`, skipping any employee who
   is the requester or has no `user_id`, terminating at a tenant admin — rather
   than two special cases. `assertNoManagerCycle` already proves the ancestor
   walk is safe and bounded (depth < 100).

3. **`subject_type` enum vs. the "zero schema additions" metric.** The success
   metric says dependent PRDs consume the primitive with *"zero schema
   additions to `approvals` beyond a `subject_type` enum value."* If
   `subject_type` is a SQL `CHECK` constraint, every consuming module needs a
   migration to widen it — which is a schema addition. **Recommended for S3:**
   keep `subject_type` a plain `TEXT` column validated by a Zod enum in the
   service layer. Same guarantee, no migration per module. Note the existing
   codebase does use `CHECK` constraints (e.g. `employees.employment_type`), so
   this is a deliberate divergence worth stating in the migration comment.

4. **Notification deep links need a route convention.** *"Each item
   deep-links to its subject"* requires a `subject_type → console route`
   mapping. That belongs in the console (S4) next to the router, not in the
   API payload — otherwise the backend owns frontend routes. Decide it once in
   S4 and every later module follows it.

---

## Session briefs

Each brief is written to be read cold. PRD-000's three sessions are fully
specified because the PRD text is in this repo. **Sessions S1 and S5–S11 are
scope sketches derived from the index's one-line descriptions and the
codebase — the PRD documents themselves are not in this repo yet.** Those
sessions must start by landing the PRD text under `docs/prd/`, exactly as S0
did for PRD-000; without it there is no acceptance-criteria list to test
against, and the brief below is not a substitute.

---

### S1 — PRD-001a: Ledger dimensions

**Needs first:** PRD-001 text in `docs/prd/`.
**Branch:** `claude/prd-001a-ledger-dimensions` · **Migration:** `0020`

**Scope:** Ledger dimensions **only**. Tax, credit notes, and multi-currency
are explicitly out — they are S11.

Why first: this alters the append-only ledger's shape, and the index is blunt
about the window — *"do this before any real customer data exists."*

**Watch:** standing rule 1 applies hardest here. Dimensions must be additive to
`journal_lines` / `journal_entries`; existing entries must remain valid and
immutable. Existing suites `test/finance-ledger.test.ts`,
`test/ledger-entries.test.ts`, `test/finance-lifecycle.test.ts`, and
`test/finance-service.test.ts` are the regression net — they must pass unchanged.

**Downstream:** S5 tags claims to the GL with project dimensions. Whatever
dimension vocabulary lands here is what S5 consumes.

---

### S2 — PRD-000a: File storage

**PRD:** [`PRD-000-platform-foundations.md`](PRD-000-platform-foundations.md) §
"P0 — File storage"
**Branch:** `claude/prd-000a-file-storage` · **Migration:** `0020` (or `0021` if S1 landed first)

**Deliverables**

- R2 bucket in **both** `wrangler.jsonc` and `wrangler.free.jsonc`; binding
  added to `src/env.ts`. Tests read `wrangler.jsonc`, so it must be there.
- `files` table: `id, tenant_id, key, filename, content_type, size_bytes,
  sha256, uploaded_by, created_at, purpose`, `purpose ∈ {quote_logo,
  claim_receipt, signature, other}` plus a soft-delete column.
- `POST /v1/files` multipart → file id. `GET /v1/files/:id` streams.
  `DELETE /v1/files/:id` soft-deletes the row and deletes the R2 object.
- Object key **must** be `{tenant_id}/{uuid}`, and the handler **must** verify
  the row's `tenant_id` against the caller before streaming. Never trust the
  key alone.
- 10 MB cap; allowlist `image/png`, `image/jpeg`, `image/webp`,
  `application/pdf`; anything else 415.
- Store SHA-256 of content — PRD-004 (S7) needs it for signature integrity.

**Acceptance criteria → tests** (`test/files.test.ts`): tenant B fetching
tenant A's file id gets **404, not 403** (do not confirm existence); 12 MB
upload → 413 with a clear message; `application/zip` → 415; deleted file → 404
*and* the R2 object is gone.

**Not in scope:** file versioning (uploads are immutable — a new file is a new
object).

---

### S3 — PRD-000b: Approvals primitive

**PRD:** [`PRD-000-platform-foundations.md`](PRD-000-platform-foundations.md) §
"P0 — Approvals primitive"
**Branch:** `claude/prd-000b-approvals` · **Depends on:** S2

**Read "Gaps found while reviewing PRD-000" above before planning.** Items 1–3
all land in this session.

**Deliverables**

- `approvals` table: `id, tenant_id, subject_type, subject_id, requested_by,
  approver_user_id, state (pending|approved|rejected|cancelled),
  decision_comment, decided_by, decided_at, created_at, idempotency_key`.
  Keep rows independent so a P2 `sequence_index` / `parent_id` can be added
  without migration pain.
- Internal service API: `requestApproval(subject)`, `decide(approvalId,
  decision, comment)`, `cancel(approvalId)`. **Not HTTP** — modules call the
  service.
- HTTP: `GET /v1/approvals?state=pending&mine=true`,
  `POST /v1/approvals/:id/approve`, `POST /v1/approvals/:id/reject`.
- Pluggable approver resolution **per `subject_type`**. Default: the employee's
  manager via People reporting lines, falling back to a tenant `admin`.
  Quote/invoice: role-based (`admin` or `finance`).
- Register `approval.requested.v1`, `approval.approved.v1`,
  `approval.rejected.v1` — one Zod file each under `src/schemas/events/`, mapped
  in `registry.ts`. **The consumer rejects unregistered types**, so an
  unregistered event is a hard failure, not a silent one.
- Decisions are **terminal**: re-deciding returns 409 listing the current
  state, matching `src/modules/support/state-machine.ts`.
- Self-approval blocked unless the approver holds `admin`.

**Acceptance criteria → tests** (`test/approvals.test.ts`): all six boxes in the
PRD, plus the manager-without-`user_id` case from gap (1).

**Do not deploy S3 without S4.** An approvals backend nobody can see is not a
feature.

---

### S4 — PRD-000c + PRD-007: Notifications & approvals inbox

**PRD:** [`PRD-000-platform-foundations.md`](PRD-000-platform-foundations.md) §
"P0 — Notifications", plus PRD-007 text (**not in repo — land it first**).
**Branch:** `claude/prd-000c-007-notifications-inbox` · **Depends on:** S3

**Deliverables**

- `notifications` table: `id, tenant_id, user_id, type, subject_type,
  subject_id, title, body, read_at, created_at`.
- Rows created by an **event consumer**, never by module code. Consumes
  `approval.requested.v1` / `approval.approved.v1` / `approval.rejected.v1`
  via `processEvent` in `src/queue/consumer.ts`. New notification types are
  added by extending the consumer's event→notification map.
- `GET /v1/notifications?unread=true`, `POST /v1/notifications/:id/read`,
  `POST /v1/notifications/read-all`.
- Console: bell icon with unread count, dropdown, each item deep-linking to its
  subject (see gap (4) — decide the `subject_type → route` map here). Poll on
  route change and every 60s while the tab is focused.
- PRD-007's approvals inbox: one place showing everything awaiting the user's
  action.

**Design constraint from the resolved open question:** on the free plan the
consumer runs inline, un-retried, and in the request path. Make the insert
idempotent on a natural key and do not throw on recoverable conditions.

**Acceptance criteria → tests** (`test/notifications.test.ts`): approver has an
unread notification within one event-bus round trip; **notification creation
works on the inline fallback path** (pattern: `test/direct-event-bus.test.ts`);
marking read decreases the count and does not reappear on refresh; tenant B
never sees tenant A's notifications.

**Explicitly not in scope:** WebSockets / Durable Object fanout, mobile push,
email fanout (P1), per-user notification preferences (P1), multi-step approval
chains (P2).

---

### S5 — PRD-006a: Expense claims

**Needs first:** PRD-006 text in `docs/prd/`.
**Branch:** `claude/prd-006a-expense-claims` · **Depends on:** S1, S2, S4

The architecture-proving session: claim → GL → cash position → project margin.
Receipt images use the S2 file primitive with `purpose = claim_receipt`.
Approval uses the S3 primitive with a new `subject_type` value — **no new
approval table, no module-local notifications** (standing rule 2). GL posting
uses S1's dimensions for project tagging.

---

### S6 — PRD-006b: Leave

**Needs first:** PRD-006 text in `docs/prd/`.
**Branch:** `claude/prd-006b-leave` · **Depends on:** S4

Table-stakes People feature. Routes through the S3 approvals primitive
(`subject_type = leave_request`), and its cancellation path exercises the PRD's
*"cancelled subject no longer appears in pending lists"* criterion.

**Time-box this one.** The index flags how leave policies actually work as a
*shaped* guess, not a structural certainty — build the minimum that works and
let the first design partner correct it. Also note the unresolved product
question in PRD-000: whether a rejected leave request is editable and
resubmitted, or must be recreated. That decides whether `approvals` needs a
`supersedes` column — **ask before assuming**, and if the answer is "editable",
it is a change to S3's table.

---

### S7 — PRD-004: Quote branding & click-to-sign

**Needs first:** PRD-004 text in `docs/prd/`.
**Branch:** `claude/prd-004-quote-signing` · **Depends on:** S2, S3, and a signatory contact from S8

Closes quote-to-cash. Logos and signature images use the S2 primitive
(`purpose = quote_logo`, `signature`); signature integrity uses the SHA-256 S2
stores. A `quote_branding` table **already exists** — extend it. Quote approval
uses S3's role-based strategy (`admin` or `finance`).

If S8 has not landed, pull it forward rather than adding a signatory field to
quotes.

---

### S8 — PRD-003: Contact roles, customer depth, health

**Needs first:** PRD-003 text in `docs/prd/`.
**Branch:** `claude/prd-003-contact-roles` · **Depends on:** S1 (loosely)

Small, high leverage. Unblocks the S7 signatory and improves S9's targeting.
Pull earlier if S7 is reached first. Existing surface: `contacts`, `customers`
tables and `src/modules/crm`.

---

### S9 — PRD-002: Collections agent guardrails & eval harness

**Needs first:** PRD-002 text in `docs/prd/`.
**Branch:** `claude/prd-002-agent-guardrails` · **Depends on:** nothing

Independent and parallelisable. **Split by urgency, per the index:** the hard
guardrails — out-of-hours sends, escalation limits, kill switch — land *before
an agent messages a stranger*. Model portability and the eval harness can
follow.

Existing surface: `src/agents/collections.ts` (the `CollectionsAgent` Durable
Object), `src/agents/decision.ts`, `src/llm/`, and
`test/collections-agent.test.ts`.

---

### S10 — PRD-005: Support customer-facing intake & tracking

**Needs first:** PRD-005 text in `docs/prd/`.
**Branch:** `claude/prd-005-support-intake` · **Depends on:** S2 (attachments only)

After the wedge is proven. Substrate only — **SupportAgent is explicitly not
being built.** Existing surface: `src/modules/support`, `tickets`,
`ticket_messages`, `test/support.test.ts`.

Note the index's flag: PRD-005's intake token may be the forcing function for
scoped/rotatable API keys, which are **designed only** —
see `docs/design/api-key-management.md`. If this session needs them, that is a
scope conversation, not a quiet addition.

---

### S11 — PRD-001b: Tax & credit notes

**Needs first:** PRD-001 text in `docs/prd/`.
**Branch:** `claude/prd-001b-tax-credit-notes` · **Depends on:** S1

**Demand-driven, not scheduled** — the index defers this until a design partner
hits it. Do not run this session speculatively; the requirements are shaped
guesses until someone else's tax situation is in the system.

---

## Deliberately not in any session

Named here so they do not get built by accident, per the index:

- **SalesAgent** — designed, not built. Its own PRD once the CRM substrate settles.
- **SupportAgent** — PRD-005 builds the substrate only.
- **Payroll and statutory submissions** — assessed and rejected as a defensible moat.
- **Apollo-style contact database** — cannot be won; enrichment stays a pluggable port.
- **Scoped/rotatable API keys** — designed only (`docs/design/api-key-management.md`).
- **Time tracking** — an open question in PRD-001, not a commitment.
- **A generic workflow engine.** PRD-000 is an approvals table, not BPMN.
