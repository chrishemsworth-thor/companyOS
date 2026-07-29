# PRD-009 — Build: Project Scheduling & Deadline Reminders

**Status:** Not started · **Priority:** P1 (first beta-user request against Build)
**Depends on:** PRD-000 (notifications) · **Blocks:** nothing

---

## Problem Statement

A project in CompanyOS is a name, a status, and a creation timestamp. It records
that a project exists; it cannot record when it was due, when it started, or
whether it was delivered on time. There is no date column on `projects` at all
and no migration has ever added one.

Every other PRD treats a project purely as a **cost tag** — a ledger dimension
for profitability (PRD-001), a tag on an expense claim (PRD-006), a field on an
approval card (PRD-007). That was a defensible reading of the codebase: the gaps
those PRDs came from were the ones visible from inside it, and Build was adequate
as a container for issues.

A beta user reading it as a *delivery* tool found the gap immediately: they asked
for start and end dates with deadline reminders for their internal records. That
is the first external signal any of these PRDs has had, which makes it worth more
than its size.

The consequence today is that PRD-001 can tell an agency owner a project's margin
but not whether they delivered it late — and late delivery is usually *why* the
margin is bad. Two halves of the same question, and only one is answerable.

## Goals

1. A project carries a schedule — intended start, committed end, actual end — so
   internal records show both the commitment and the outcome.
2. Someone accountable is reminded **before** a deadline, while there is still
   time to act, not after it has passed.
3. Reminders are delivered through the PRD-000 notifications primitive. No new
   reminder mechanism, no module-local notification table.
4. Projects running late are visible in one list without opening each one.
5. No change to the ledger-dimension contract — `project_id` stays the join key,
   and the profitability rollup is untouched.

## Non-Goals

- **Gantt charts, dependency graphs, critical path.** A dependency graph is a
  different product with a much larger surface, and Malaysian SME agencies mostly
  run projects that are late for commercial reasons, not sequencing ones.
- **Resource levelling / capacity planning.** Needs per-person availability the
  system does not hold.
- **Time tracking.** Still deliberately unbuilt and still its own open question
  in PRD-001. Actual-vs-committed *dates* are not the same thing as logged hours,
  and this PRD delivers only the former.
- **Milestones as first-class entities.** P1 at most. A project with one committed
  end date is the 80% case; milestones invite a scheduling engine.
- **A client-facing project status page.** P2 — the pattern exists (PRD-004's
  public token link) but the demand does not yet.
- **Recurring or templated projects.** No signal for it.
- **Changing the issue model.** Issues already have their own status; this PRD
  does not add dates to them.

## User Stories

- As an agency owner, I want a project to carry start and committed end dates so
  that my internal records show what we actually promised.
- As a project owner, I want a reminder a week before the deadline so that I can
  act while it is still recoverable.
- As an operator, I want one list of projects running late so that I do not
  discover a slip in a client email.
- As a finance operator, I want committed-versus-actual end dates next to project
  margin so that I can see whether late projects are also the unprofitable ones.
- As an admin, I want a project with nobody assigned to still reach someone so
  that a deadline is not missed because a field was left blank.

## Requirements

### P0 — Schedule fields

- Add to `projects`, all **nullable**: `start_date`, `target_end_date`,
  `actual_end_date` (ISO dates), and `owner_user_id` (the reminder recipient).
- Nullable is load-bearing: every existing project stays valid and no backfill is
  required, exactly as with the PRD-001a ledger dimensions.
- `target_end_date` must not precede `start_date` — 400, validated in the service
  so every caller gets the rule.
- `actual_end_date` is set explicitly, or defaulted to the archive date when a
  project is archived without one. Archiving is the existing completion signal;
  this PRD does not add a `completed` state (see Open Questions).
- Console: the three dates and an owner on project create/edit, shown on the
  project detail page.

**Acceptance criteria**
- [ ] Given a project created with no dates, then it posts successfully and
      behaves exactly as before (backwards compatible).
- [ ] Given a `target_end_date` earlier than `start_date`, then 400.
- [ ] Given a project archived with no `actual_end_date`, then it is set to the
      archive date.
- [ ] Given an existing project used as a ledger dimension, then the PRD-001a
      profitability rollup returns the same figures as before this migration.

### P0 — Deadline reminders through PRD-000 notifications

- A **daily sweep**, extending the existing daily cron (`0 1 * * *`) rather than
  adding a second trigger. The invoice overdue sweep is the pattern to mirror.
- Per-tenant configurable **lead times**, defaulting to 7 days and 1 day before
  `target_end_date`.
- Emits `project.deadline_approaching.v1` (with which threshold fired) and
  `project.overdue.v1`.
- The PRD-000 notification consumer maps both to rows for `owner_user_id`,
  falling back to a tenant admin when no owner is set — the same reasoning as
  approver resolution: never route work to nobody.
- **Fires once per (project, threshold).** The sweep runs daily and must not
  re-notify every morning; that is how a badge becomes noise and gets ignored.
- Archived projects never remind, whatever their dates say.
- Projects with no `target_end_date` are silently skipped — no date, no deadline,
  no reminder.

**Acceptance criteria**
- [ ] Given a project with `target_end_date` 7 days out and a 7-day lead time,
      when the sweep runs, then `project.deadline_approaching.v1` is emitted and
      the owner has an unread notification.
- [ ] Given the sweep runs twice on the same day, then exactly one notification
      exists for that (project, threshold).
- [ ] Given a project past `target_end_date` and not archived, then
      `project.overdue.v1` is emitted once, not once per sweep.
- [ ] Given an archived project past its `target_end_date`, then no event is
      emitted.
- [ ] Given a project with no `owner_user_id`, then the notification goes to a
      tenant admin.
- [ ] Given the free-plan inline event fallback, then the notification is still
      created (mirrors the PRD-000 criterion).
- [ ] Given a user from tenant B, then tenant A's project notifications are never
      returned.

### P0 — Schedule visibility

- `GET /v1/projects?schedule=late|due_soon|on_track|no_date` — a filter over the
  new dates, no new read model.
- Console: date columns on the project list, with a prominent late badge, and the
  committed-versus-actual end date on the detail page.
- Projects with no `target_end_date` group under an explicit **"No date set"**
  rather than counting as on-track. Same principle as PRD-001a's "Unallocated"
  bucket: an absent value is a fact, not a pass.

**Acceptance criteria**
- [ ] Given three projects — one late, one due soon, one with no date — then each
      filter returns only its own.
- [ ] Given a project with no `target_end_date`, then it appears under "No date
      set" and never under `on_track`.

## P1

- Milestones with their own dates and their own reminders.
- Per-project override of the tenant's reminder lead times.
- A committed-versus-actual delivery report alongside PRD-001's profitability
  rollup — the join that answers "are our late projects also our unprofitable
  ones?".
- iCal feed of project deadlines.
- Reminder escalation to the tenant admin when an overdue project goes
  unacknowledged for N days.

## P2 (design for, do not build)

- **Project dependencies / critical path.** Keep the dates on the `projects` row
  so a `depends_on_project_id` is additive rather than a restructure.
- **Client-facing project status page**, following PRD-004's hashed public-token
  pattern rather than inventing a second one.
- **A BuildAgent** that flags slipping projects, drafts a client update, and
  proposes a revised date. Keep every project event on the bus with full context
  so it needs no new plumbing — the same discipline PRD-005 applies to its own
  future agent.

## Success Metrics

- A late project is visible from the project list without opening it.
- A deadline reminder reaches its owner exactly once per threshold — verifiable
  by running the sweep repeatedly in a test and asserting the notification count.
- Zero new notification or reminder mechanisms: every reminder in this PRD is a
  PRD-000 notification row created by the shared consumer.
- The PRD-001a profitability figures are unchanged by this PRD's migration.

## Open Questions

- **(Product, blocking)** Who is the reminder actually for, and what do they do
  when it fires? The beta user's phrasing — *"deadline reminder for our internal
  records"* — bundles two different asks: a stored date for reporting (a column)
  and an interruption that reaches a human (needs a recipient, a lead time, and a
  repeat policy). Confirm with them before the lead-time defaults are fixed.
  Building the column is safe either way; building the wrong reminder cadence
  trains people to ignore notifications.
- **(Product, non-blocking)** Does a project need a `completed` state distinct
  from `archived`? This PRD treats archiving as completion and stamps
  `actual_end_date`, which conflates "delivered" with "filed away". A distinct
  state is cleaner but changes an existing state machine.
- **(Product, non-blocking)** Should overdue projects appear in PRD-007's "Needs
  your attention" tile? PRD-007 asks the same question for overdue invoices and
  breached-SLA tickets and defers it. Decide it **once for all three** rather
  than per module, or the tile becomes a second dashboard by accretion.
- **(Engineering, non-blocking)** How is once-per-threshold enforced — a
  `project_reminders_sent` table, or derived from existing `notifications` rows?
  Deriving avoids a table but couples Build to the notifications schema; a small
  table keeps the modules independent.

## Timeline Considerations

**Hard-blocked on PRD-000 notifications** (session S4). The schedule fields and
the visibility filter could ship before it, but a deadline nobody is told about is
the same non-feature as an approval nobody is told about — and PRD-000 makes that
argument in its own timeline section.

Everything here is additive: nullable columns, one extended cron sweep, two new
event types, and one filter. There is no migration risk to the ledger and no
change to existing write paths.

Suggested phasing:

1. Schedule fields + validation + console edit
2. Sweep + reminders through the notification consumer
3. Visibility filter + late badge

Do not start phase 2 before the blocking open question is answered — the cadence
is the part that is easy to get wrong and expensive to un-train.
