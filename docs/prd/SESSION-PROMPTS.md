# Session prompts — S3 to S13

Copy-paste openers, one per remaining session. Each is self-contained: it names
the brief, the PRD sections, and the specific conflicts or decisions in
[`SESSION-PLAN.md`](SESSION-PLAN.md) that would otherwise be rediscovered
mid-implementation.

**Run them in order.** The dependency column in the plan's session map is real —
S4 needs S3's approvals table, S5 and S7 need S4's inbox registry, S9 needs S8's
`signatory` role. S10 is the only one with no dependencies and can be pulled
forward if you are blocked elsewhere.

**Before starting any session**, check `main` for what landed since the last one.
Sessions take the next free migration number, and `main` moves.

Done so far: **S0** (plan + all eight PRDs), **S1** (ledger dimensions +
profitability), **S2** (file storage with per-purpose policy).

---

## S3 — Approvals primitive (PRD-000b)

```
Read docs/prd/SESSION-PLAN.md and the brief for S3, plus
docs/prd/PRD-000-platform-foundations.md § "P0 — Approvals primitive".

Read conflicts C1, C5 and C8 in the plan before you plan anything — the approver
resolution rule, the reserved `invoice` subject type, and what happens on
resubmission are all already decided there, and C1 in particular changes the
shape of the resolution function.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, event types to register in the schema registry, and the
test files you will add. Confirm the plan before implementing. Every acceptance
criterion must have a corresponding test in the Workers runtime suite, including
the manager-who-has-no-console-login case that the PRD does not cover.

Do not deploy this without S4 following it — an approvals backend nobody can see
is not a feature.
```

## S4 — Notifications + approvals inbox shell (PRD-000c + PRD-007)

```
Read docs/prd/SESSION-PLAN.md and the brief for S4, plus
docs/prd/PRD-000-platform-foundations.md § "P0 — Notifications" and all of
docs/prd/PRD-007-console-approvals-inbox.md.

Read conflicts C4 and C5 and the resolved free-plan question in the plan first.
Three things are already decided: the nudge emits an event rather than inserting
a notification row directly, no invoice renderer gets built, and the notification
consumer must be idempotent and non-throwing because the free-plan path neither
retries nor runs outside the request.

This session builds the inbox shell, the renderer registry and the generic
fallback card only. The leave and claim renderers ship with S5/S7 and the quote
renderer with S9 — do not build them here.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, event types to register in the schema registry, console
routes and components, and the test files you will add. Confirm the plan before
implementing. Every acceptance criterion from both PRDs must have a corresponding
test in the Workers runtime suite, including notification creation on the inline
free-plan event path.

This is the largest session in the plan. If it has to split, the seam is backend
(notifications API + consumer) versus console (bell + inbox).
```

## S5 — Expense claims + GL posting (PRD-006a)

```
Read docs/prd/SESSION-PLAN.md and the brief for S5, plus
docs/prd/PRD-006-people-leave-and-claims.md §§ "Claims: submission" and
"Claims: approval and GL posting".

Read conflict C2 first: the SST Input leg of the claim posting is out of scope
here because the tax work it depends on has not landed. Post the two-leg entry
and do not invent an SST account.

Approval goes through the S3 primitive with a new subject_type value, receipts
through the S2 file primitive with purpose = claim_receipt, and GL dimensions
come from S1. Do not add an approval table or a module-local notification path.
Also ship the claim card for S4's renderer registry, with the receipt image
inline and zoomable.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, event types to register in the schema registry, and the
test files you will add. Confirm the plan before implementing. Every acceptance
criterion must have a corresponding test in the Workers runtime suite — including
the atomicity one: no approved claim without its journal entry.
```

## S6 — Leave policy, holidays, balances (PRD-006b)

```
Read docs/prd/SESSION-PLAN.md and the brief for S6, plus
docs/prd/PRD-006-people-leave-and-claims.md §§ "Leave: policy and entitlement"
and "Leave: public holidays".

This session is policy, holidays and balances only — requests, approval and the
team calendar are S7.

One decision is needed before starting: where public-holiday data comes from each
year. The plan recommends a data file shipped with releases rather than a manual
per-tenant seed, because state variation makes manual seeding an annual support
burden. Confirm with me if you disagree.

Seed Malaysian defaults for leave types and Employment Act minimums, but treat
the minimums as a warning on save, never an enforced floor — a tenant may have
contractual terms above minimum and the system must not fight them.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, and the test files you will add. Confirm the plan before
implementing. Every acceptance criterion must have a corresponding test in the
Workers runtime suite — balance correctness across mid-year joins, carry-forward
caps and state holidays especially, because a wrong balance destroys trust
permanently.
```

## S7 — Leave requests, approval, team calendar (PRD-006c)

```
Read docs/prd/SESSION-PLAN.md and the brief for S7, plus
docs/prd/PRD-006-people-leave-and-claims.md § "Leave: request and approval".

Builds on S6's entitlement and balance logic. Requests route through the S3
approvals primitive, which already walks up the reporting chain and falls back to
an admin. Also ship the leave card for S4's renderer registry, showing the
remaining balance after approval and any overlapping team leave.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, event types to register in the schema registry, console
routes, and the test files you will add. Confirm the plan before implementing.
Every acceptance criterion must have a corresponding test in the Workers runtime
suite, including PRD-000's criterion that a cancelled subject disappears from
pending approval lists.

Time-box this. How leave policies actually work is a shaped guess until a design
partner corrects it — build the minimum that works.
```

## S8 — Contact roles, customer depth, health (PRD-003)

```
Read docs/prd/SESSION-PLAN.md and the brief for S8, plus
docs/prd/PRD-003-crm-depth.md.

Read conflict C7 first: payment_terms_days drives automatic invoice due dates, so
this session changes a finance write path and must keep the existing finance
suites green.

Contact roles are the must-land part — they unblock S9's signatory and improve
S10's agent targeting. PRD-003's own guidance is to do roles first and ship them
before deciding whether attributes and health are still the right next thing. If
the session runs long, stop after roles and tell me rather than rushing health.

One decision is needed before building health: whether `at_risk` automatically
pauses outbound sales activity or only surfaces as a signal. The plan recommends
signal-only in v1 — auto-pause is the more impressive behaviour and the more
dangerous one.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, event types to register in the schema registry, and the
test files you will add. Confirm the plan before implementing. Every acceptance
criterion must have a corresponding test in the Workers runtime suite.
```

## S9 — Quote branding & click-to-sign (PRD-004)

```
Read docs/prd/SESSION-PLAN.md and the brief for S9, plus
docs/prd/PRD-004-quote-branding-and-signing.md.

Read conflict C3 first — but note S2 already built per-purpose file policy, so the
publicly-readable quote_logo path exists; reuse src/modules/files/policy.ts
rather than adding a second read path. A quote_branding table also already exists;
extend it rather than starting fresh.

Follow PRD-004's own internal order: immutability rules, then the public link,
then acceptance and audit, then the logo, then internal sign-off. Immutability is
the load-bearing requirement — if a sent quote can change, the signature is
worthless. Internal sign-off is P1 in this PRD and is the only part that needs
the S3 approvals primitive.

Also ship the quote card for S4's renderer registry.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints (including the unauthenticated /q/:token surface and its
rate limiting), event types to register in the schema registry, and the test files
you will add. Confirm the plan before implementing. Every acceptance criterion
must have a corresponding test in the Workers runtime suite — especially that the
archived artifact's SHA-256 matches the acceptance record, and that it still
renders identically after the tenant changes their branding.
```

## S10 — Agent guardrails, eval harness, observability (PRD-002)

```
Read docs/prd/SESSION-PLAN.md and the brief for S10, plus
docs/prd/PRD-002-agent-portability-and-eval.md.

Read conflict C6 first. Two things it establishes: there is no tenant timezone
setting anywhere in src/, and one P0 guardrail depends on it, so adding it to
/v1/settings is part of this session; and the "disputed invoice (credit note
pending)" eval scenario reaches into work that has not landed, so it ships as a
fixture-only context.

Guardrails first, then the eval harness, then observability. Guardrails are the
difference between an agent that is safe to leave running and one that needs
supervision. If S6 has landed, reuse its public_holidays table rather than
building a second holiday source.

One decision is needed before starting: the default escalation threshold in days.
Malaysian SME payment norms run 60–90 days in practice, so 30 may be culturally
aggressive. Ship it tenant-configurable with a conservative default.

Note that extending the decision event is a breaking payload change, so it is a
collections.decision.v2 file and a registry bump, not an edit.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, event types to register in the schema registry, the evals/
layout, and the test files you will add. Confirm the plan before implementing.
Every acceptance criterion must have a corresponding test in the Workers runtime
suite. Nothing in this session may change the fallback guarantee — collections
never silently stops.
```

## S11 — Support customer-facing intake & tracking (PRD-005)

```
Read docs/prd/SESSION-PLAN.md and the brief for S11, plus
docs/prd/PRD-005-support-intake-and-tracking.md.

Read the resolved PRD-005 Gmail question in the plan before designing threading —
it changes the approach. Gmail's own thread id is already carried end to end on
email.received.v1 and the outbound sender already accepts it, so thread on that
and demote the [#TKT-1234] subject token to a fallback. The plan also names three
concrete gaps to close: exposing the RFC822 headers (a one-line change to a
generic header map), fetching the body (the current metadata-only fetch returns
none), and the Auto-Submitted/Precedence headers your loop-protection criterion
needs.

Follow PRD-005's order: threading and email-to-ticket, then the public tracking
page with the internal-note flag, then assignment and SLA, then attachments, then
the public intake token. Assignment notifies through the S4 primitive.
Attachments and public uploads go through S2's per-purpose file policy.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, event types to register in the schema registry, and the
test files you will add. Confirm the plan before implementing. Every acceptance
criterion must have a corresponding test in the Workers runtime suite. Two are
security-critical and must assert on the API response rather than the UI: an
internal note never appears on the public page, and an intake token cannot be
used for any endpoint other than ticket creation.

If this needs scoped API keys rather than a purpose-built intake token, stop and
ask — that is a scope conversation, not a quiet addition.
```

## S12 — Tax / SST (PRD-001b)

```
Read docs/prd/SESSION-PLAN.md and the brief for S12, plus
docs/prd/PRD-001-finance-ledger-completeness.md § "P0 — Tax (SST)".

Read conflict C2: when this lands, add the SST Input leg to S5's expense-claim
posting, which was deliberately left out while tax did not exist.

Tax goes at line level on invoices and quotes — header-level tax cannot represent
a mixed-rate invoice. Rounding is per line, rounded to the cent, then summed;
document that and do not compute on the header total and allocate back. Seed
Malaysian defaults but keep rates fully editable and do not hardcode them.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, changes to invoice posting, and the test files you will
add. Confirm the plan before implementing. Every acceptance criterion must have a
corresponding test in the Workers runtime suite, including that tax and net
credits sum exactly to the AR debit with no rounding drift.

Confirm current Malaysian SST rates and service-tax scope before seeding
defaults — seed values are a starting point for tenants to edit, not advice.
```

## S13 — Credit notes + ledger multi-currency (PRD-001c)

```
Read docs/prd/SESSION-PLAN.md and the brief for S13, plus
docs/prd/PRD-001-finance-ledger-completeness.md §§ "P0 — Credit notes" and
"P0 — Ledger multi-currency".

Issuing a credit note posts a real transaction, not a reversal, so both documents
stay in the customer's history. A fully credited invoice is excluded from the
overdue sweep and from the CollectionsAgent's open-invoice context, so this
session touches the agent. For multi-currency, balance enforcement stays on
functional amounts only.

One decision is needed before starting: whether `credited` is a distinct invoice
state or derived from credit note totals. Derived is cleaner but complicates the
sweep query.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, event types to register in the schema registry, changes to
the overdue sweep and agent context, and the test files you will add. Confirm the
plan before implementing. Every acceptance criterion must have a corresponding
test in the Workers runtime suite.

When this lands it unblocks S10's disputed-invoice eval scenario, which shipped
as a fixture-only context — wire it to real credit-note data if S10 has run.
```

## S14 — Project scheduling & deadline reminders (PRD-009)

```
Read docs/prd/SESSION-PLAN.md and the brief for S14, plus
docs/prd/PRD-009-project-scheduling.md.

This one came from a beta user rather than from the codebase, so treat its scope
as evidenced rather than guessed — but note its blocking open question: who the
reminder is for and how often it fires. Build the schedule columns and the
visibility filter regardless; stop and ask before fixing the reminder cadence if
that question is still open.

Extend the existing daily cron rather than adding a second trigger — mirror
src/modules/finance/overdue-sweep.ts. Reminders become notification rows by
extending the S4 consumer's event-to-notification map, which is the designed way
to add a type; do not create a reminder mechanism inside the Build module. A
project with no owner falls back to a tenant admin, same reasoning as approver
resolution in conflict C1.

Before writing code, produce an implementation plan covering D1 migrations,
new/changed endpoints, event types to register in the schema registry, the change
to the daily sweep, and the test files you will add. Confirm the plan before
implementing. Every acceptance criterion must have a corresponding test in the
Workers runtime suite — including that running the sweep twice produces exactly
one notification, that archived projects stay silent, and that the PRD-001a
profitability figures are unchanged by this migration.
```

---

## Unslotted: PRD-008 (roles & permissions)

PRD-008 is in `docs/prd/` but has no session number yet — see "Unslotted work" in
the plan. It is P0, it blocks PRD-006 self-service, and the suggested position is
**immediately after S4, before S5**. Once that is decided it needs a session row,
a brief, and a prompt here.

---

## After the last session

Nothing in this plan covers the P1 and P2 items each PRD defers, and that is
deliberate — several are shaped guesses that want a design partner's correction
rather than a build. The plan's "Deliberately not in any session" section lists
what must not get built by accident.
