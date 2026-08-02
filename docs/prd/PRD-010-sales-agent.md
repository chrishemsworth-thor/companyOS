# PRD-010 — Sales: Sequences & the SalesAgent

**Status:** Not started · **Priority:** P1 (the highest-leverage gap named in `direction.md`)
**Depends on:** PRD-003 (contact roles — targeting), **PRD-002 (guardrails — safety)**
**Blocks:** nothing · **Design doc:** [`../architecture/sales-module-design.md`](../architecture/sales-module-design.md) Phases B and C

---

## Problem Statement

CompanyOS is an agent-first business operating system with exactly one agent. The
CollectionsAgent chases overdue invoices autonomously — assembles cross-module
context, decides, sends, re-checks on an alarm. Finance is therefore the only
department where the system *acts* rather than records.

Sales has been the named primary gap since `direction.md` was written: *"the
pipeline data model already exists, but it's inert: no prospecting fills it, no
sequences work it, and no agent advances it. Because the spine (customers, deals,
activities) is already there, this is the cheapest place to add real autonomy and
the most valuable."*

Since then the inert layer has grown and the animating layer has not. Leads and
an enrichment port shipped (Phase A of the sales design, migration `0018`).
Quotes and quote-to-cash shipped. PRD-003 added contact roles and customer
health. Every one of those made the sales *record* richer. None of them made
anything happen. A CompanyOS tenant today can describe their pipeline in more
detail than most CRMs and still has to work it entirely by hand.

The gap has a specific shape. A lead sits at `status = 'new'` until a human
remembers it. `docs/modules/crm.md` has said since Phase 1 that *"a future
SalesAgent claims them via `AGENT_ROUTES`"*, and `AGENT_ROUTES` still maps two
event types, both to collections.

This PRD builds the thing every other document points at.

### Why now and not earlier

The deferral was recorded as *"its own PRD once the CRM substrate settles"*, and
that condition is now met rather than merely asserted:

- **Targeting exists.** PRD-003's `resolveContact(customerId, role)` means an
  agent can address the person who actually holds a role instead of guessing.
  Before it, an outreach agent would have emailed whoever was first in the table.
- **A health signal exists.** PRD-003 ships a derived band plus reasons, and
  deliberately does *not* act on it — it was built as an input for exactly this
  kind of consumer.
- **The safety layer is specified.** PRD-002 puts hard guardrails, a kill switch
  and an eval harness in code. Sequences without those is an unsupervised
  outbound sender.

## Goals

1. A tenant can define a multi-step outreach cadence and enrol a lead in it.
2. The **SalesAgent advances enrolments on its own**, with no human in the loop
   and no cron babysitting it — Sales reaches parity with Finance on
   `direction.md`'s "an agent acts on it" yardstick.
3. Every send passes through the **same** guardrail layer PRD-002 builds for
   collections. There is one place that decides whether an outbound message may
   leave, not two.
4. A reply, a bounce, or a conversion **stops the cadence** — the failure mode
   that destroys trust in outbound tooling is a sequence that keeps sending after
   the prospect has answered.
5. The agent's decisions are inspectable after the fact through the same event
   audit trail collections uses, and scoreable by the same eval harness.

## Non-Goals

- **A contact database.** Apollo's moat is 210M proprietary contacts. Enrichment
  stays a pluggable port with a no-op default; we do not host or resell data.
- **Real telephony / dialer.** Engagement is *tracked*; calls are logged, not
  placed.
- **LinkedIn or any platform automation.** Terms-of-service risk with no moat.
- **AI-written net-new prospecting lists.** The agent works a pipeline a human
  filled; it does not invent recipients.
- **A generic workflow engine.** This is an ordered list of steps with delays,
  not BPMN. Same discipline PRD-000 applied to approvals.
- **Meeting booking / calendar links.** Design-doc Phase D.
- **Sequence A/B testing and open/click tracking pixels.** P1 at best; tracking
  pixels in particular are a deliverability and privacy decision that wants a
  design partner, not a default.

## User Stories

- As a sales operator, I want to define a three-touch follow-up cadence once so
  that every new lead gets worked the same way without me remembering.
- As a sales operator, I want a lead that replies to be dropped from the cadence
  automatically so that we never send a follow-up to someone who already answered.
- As the SalesAgent, I want to know which contact holds the role I am writing to
  so that I address the decision-maker rather than whoever was created first.
- As a business owner, I want one switch that stops all outbound agent activity
  so that I can react to a complaint in seconds, not by deploying.
- As a business owner, I want to see what the agent sent, to whom, and why, so
  that I can trust it to run unattended.

---

## Requirements

### P0 — Sequences and enrolments

The cadence model. Design-doc Phase B, folded in here rather than given its own
session: a sequence with nothing advancing it is more inert layer, which is the
mistake this PRD exists to correct.

- `sequences` — per tenant: name, status (`draft | active | archived`), the
  channel default, and whether it auto-stops on reply (default **yes**).
- `sequence_steps` — ordered steps on a sequence: `step_no`, `channel`
  (`email | whatsapp`), `delay_days` from the previous step, a body template,
  and the **contact role to address** (defaults to `primary`, resolved through
  PRD-003's `resolveContact`).
- `sequence_enrollments` — a lead's position: `sequence_id`, `lead_id`,
  `current_step_no`, `next_due_at`, `state`
  (`active | paused | completed | stopped`), `stop_reason`.
- Enrol a lead: `POST /v1/sequences/:id/enrol`. **A lead may hold at most one
  active enrolment** — 409 otherwise, matching the existing state-machine
  convention (`src/modules/support/state-machine.ts`).
- Enrolling in a `draft` sequence is a 409. A sequence with zero steps cannot be
  activated.
- Editing a step on an `active` sequence affects only steps **not yet sent**;
  already-sent steps are history. Deleting a step that enrolments have passed is
  a 409.

**Acceptance criteria**
- [ ] Given a sequence with three steps at 0/3/7 days, when a lead is enrolled,
      then `next_due_at` is now and `current_step_no` is 0.
- [ ] Given a lead already actively enrolled, when it is enrolled again, then 409
      and no second enrolment row exists.
- [ ] Given a `draft` sequence, when a lead is enrolled, then 409.
- [ ] Given an enrolment that has sent step 1, when step 1's body is edited, then
      the sent record is unchanged and step 2 uses the new content.

### P0 — The SalesAgent

The payoff. A Durable Object modelled on `src/agents/collections.ts` — one
instance per `(tenant, enrollment)`, addressed by `idFromName`.

- Wakes on `alarm()` at `next_due_at`, assembles context, decides, sends through
  the existing `delivery/` port, logs an engagement activity, and schedules the
  next step. Finishing the last step completes the enrolment.
- **Context assembly reuses what exists**: the lead, its converted customer if
  any, `resolveContact` for the step's role, PRD-003 customer health, open deals,
  and the recent `activities` log. No new read model.
- **The LLM personalises within a fixed frame.** The step template is the
  contract; the model adapts tone and references real context. Same structure as
  `src/agents/decision.ts`: a Zod-validated structured decision with a
  **deterministic template fallback** on any failure. Outreach never silently
  stops, and it never sends unvalidated model output.
- The model may return `skip` for a step (e.g. the account just went `at_risk`
  over an unpaid invoice and a cheerful upsell would be tone-deaf). A skip
  advances the schedule and is audited; it does not stop the sequence.
- **Auto-stop conditions**, all of which set `state = 'stopped'` with a
  `stop_reason`: the lead replies, the lead converts, the lead is marked `lost`,
  a hard bounce, or an operator pauses it. Reply detection rides the existing
  `email.received` stream (the same one PRD-005 consumes) matched on sender.
- Wired by adding the sequence events to `AGENT_ROUTES` in
  `src/queue/consumer.ts`.

**Acceptance criteria**
- [ ] Given an enrolment due now, when the alarm fires, then the step is sent via
      the delivery port, an `activity` row is written, `current_step_no`
      advances, and the next alarm is set to the following step's delay.
- [ ] Given the final step has sent, then the enrolment is `completed` and no
      further alarm is scheduled.
- [ ] Given an inbound email from the lead's address, then the enrolment is
      `stopped` with `stop_reason = 'replied'` and no further step is sent.
- [ ] Given a lead that converts to a customer mid-sequence, then the enrolment
      is `stopped` with `stop_reason = 'converted'`.
- [ ] Given the LLM returns malformed output, then the deterministic template is
      sent and the decision event records `source = 'fallback'`.
- [ ] Given a step whose role resolves to no contact, then nothing is sent, the
      enrolment is `paused`, and the reason is recorded — it does not throw and
      does not silently skip.

### P0 — One guardrail layer, shared with collections

**This is the requirement that makes the rest safe to ship**, and the reason this
PRD depends on PRD-002 rather than merely referencing it.

- Every SalesAgent send passes through the **same** guard PRD-002 builds:
  business-hours window in tenant-local time, weekend and Malaysian public
  holiday suppression, per-customer contact cooldown, the `agents.enabled` kill
  switch and the per-customer `agent_paused` flag.
- **The guard is extended, not copied.** If PRD-002's guard is collections-shaped
  when this session starts, generalising it is in scope here. Two guard
  implementations means two places to fix a 2am WhatsApp, and PRD-002 is explicit
  that *"a WhatsApp at 2am is a product-defining mistake."*
- **Out-of-hours defers, never drops** — the same rule PRD-002 sets. A step due
  at 21:00 sends at 09:00 the next working day; the enrolment does not skip it.
- A per-tenant **daily outbound cap** across all sequences, conservative by
  default. A cadence bug that mails a whole lead list in one alarm sweep is the
  single most expensive failure available here.
- Every guardrail intervention logs `guardrail.override.v1` (PRD-002's event) —
  no new event type for the same concept.

**Acceptance criteria**
- [ ] Given `agents.enabled = false`, then no step is sent and the alarm still
      re-arms — the same shape as PRD-002's collections criterion.
- [ ] Given a step falls due at 02:00 tenant-local, then it sends at the next
      window open and is not skipped.
- [ ] Given a step falls due on a Malaysian public holiday, then it defers, using
      `effectiveHolidays()` from PRD-006b rather than a second holiday source.
- [ ] Given the tenant's daily cap is reached, then remaining steps defer to the
      next day and the cap event is logged.
- [ ] Given a customer with `agent_paused`, then neither collections nor sales
      contacts them.

### P0 — Observability and eval

- `sequence.created`, `sequence.enrolled`, `sequence.step_sent`,
  `sequence.step_skipped`, `sequence.completed`, `sequence.stopped`, and
  `sales.decision.v1` (the agent's audit record, mirroring
  `collections.decision`). All Zod-registered — the consumer rejects unregistered
  types.
- **Eval scenarios reuse PRD-002's harness**, which PRD-002 requires be *"a
  generic runner keyed on an agent's decision function so the future SalesAgent
  and SupportAgent reuse it."* If that generalisation did not happen in S10, doing
  it here is in scope; writing a second runner is not.
- Scenarios must cover: a healthy prospect, an `at_risk` account mid-sequence, a
  lead with no resolvable contact, a lead who replied between steps, and a
  degenerate empty context.
- Console: sequence list with enrolment counts, an enrolment timeline showing
  what was sent and when, and the stop reason where one applies.

**Acceptance criteria**
- [ ] Given any send, then a `sales.decision` event records the step, the
      resolved contact and how it was matched, the provider/model, and whether
      the fallback or a guardrail fired.
- [ ] Given `npm run eval`, then the sales scenarios run through the same runner
      as the collections scenarios.

### P1

- Open and reply-rate metrics folded into `insights`.
- Sequence templates seeded per tenant.
- Branching cadences (different next step by engagement).
- Enrolling a whole segment rather than one lead at a time.
- SMS/WhatsApp template approval flow (Meta requires pre-approved templates for
  business-initiated messages — a real constraint, not a nicety, once WhatsApp is
  the channel).

### P2 (design for, do not build)

- External data-provider integration behind the enrichment port (design-doc
  Phase D).
- Meeting booking and calendar sync.
- A/B testing of step content.

---

## Success Metrics

- A lead enrolled in a cadence is worked to completion with **zero human
  actions** between enrolment and the final step.
- Zero sends outside the tenant's business-hours window across the eval suite and
  a week of staging traffic.
- Zero sends to a lead who has replied — measured as a hard count, not a rate.
  One is a bug.
- Guardrail override rate under 10% on the eval suite, matching PRD-002's
  threshold: a higher number means the prompt is wrong, not that the guardrails
  are working.
- `direction.md`'s Sales row moves off "Primary gap".

## Open Questions

- **(Product, blocking)** Does an outbound step to a lead who is *not yet a
  customer* need explicit per-tenant opt-in beyond `agents.enabled`? Cold
  outreach carries different risk from chasing an invoice on an existing
  relationship, and PDPA consent posture differs. Recommendation: a separate
  `agents.outbound_sales_enabled`, defaulting **off**, so enabling collections
  never silently enables prospecting.
- **(Product, non-blocking)** Should a lead's `preferred_channel` (PRD-003, on
  the customer) override the step's channel once the lead converts?
- **(Legal, non-blocking)** PDPA obligations for unsolicited B2B outreach in
  Malaysia. Does not block the build; does block pointing it at a bought list.
- **(Engineering, non-blocking)** One DO per enrolment, or one per lead? Per
  enrolment matches the collections precedent and keeps the alarm trivially
  scoped; per lead would make "one active enrolment per lead" enforceable in the
  DO rather than in SQL.

## Timeline Considerations

**PRD-002 must land first.** Not a preference: this PRD's P0 guardrail block is
defined as an extension of PRD-002's guard, and shipping autonomous outbound
before the kill switch and the business-hours window exists would be the exact
mistake PRD-002 was written to prevent.

PRD-003 has landed, so the targeting dependency is satisfied.

Within this PRD, the order is **sequences → agent → guardrail wiring → eval**,
with one caveat: do not merge sequences on their own if the session runs short.
A cadence model with no agent is another layer of inert schema, and this PRD
exists because that pattern has repeated four times. If the session cannot reach
the agent, ship nothing and re-scope.
