# PRD-007 — Console: Approvals Inbox & Notification Experience

**Status:** Not started · **Priority:** P0 (the primitive is invisible without this)
**Depends on:** PRD-000 (approvals + notifications API), consumes PRD-004 and PRD-006

---

## Problem Statement

PRD-000 builds approvals and notifications as backend primitives. Without a console
experience, they are invisible: a manager has no way to know a leave request is waiting,
and would have to navigate to the People module, find the employee, and open the request.
That is how approval features die — the approver never comes, the requester chases on
WhatsApp anyway, and the module gets abandoned for the spreadsheet it replaced.

The decisive property is not features, it is **time to decide**. If a manager can act on
a request in under 30 seconds, on a phone, from a notification, the workflow holds. If it
takes navigation and hunting, it does not.

## Goals

1. One place shows a user everything awaiting their action, across every module.
2. A manager can approve or reject with full context without leaving the inbox.
3. The console is usable on a phone browser for approvals specifically — approvers are
   frequently not at a desk.
4. Adding a new approvable entity type requires no new console screens.
5. Nothing awaiting action is discoverable only by remembering to look.

## Non-Goals

- **Native mobile app.** Responsive web only.
- **Real-time push / WebSockets.** Polling per PRD-000.
- **Approval via email reply or WhatsApp reply.** Compelling but a separate PRD with real
  security questions (an email reply is a weak authentication signal for a financial approval).
- **Bulk approval of unrelated items.** Encourages rubber-stamping. Bulk within a single
  type (e.g. five leave requests) is P1.
- **Delegation during absence.** P1, and dependent on PRD-000's approver strategy.
- **A notification preference centre.** P1.

## User Stories

- As a manager, I want a badge telling me how many things need my decision so that I do
  not have to check each module.
- As a manager, I want to see the leave request's dates, the employee's remaining balance,
  and who else on the team is off — in the approval card itself — so that I can decide
  without opening another screen.
- As a manager, I want to see the receipt image inline on a claim so that I can approve
  from my phone.
- As a finance approver, I want to see the quote total and margin before signing off so
  that I am not approving blind.
- As a requester, I want to know who my request is with and when it was sent so that I
  know whether to nudge.
- As any user, I want notifications to clear once acted on so that the badge means something.

## Requirements

### P0 — Notification bell

- Header bell with unread count, on every console page.
- Dropdown: recent notifications, grouped by type, each deep-linking to its subject.
- Mark-as-read on click; mark-all-read action.
- Poll on route change and every 60s while the tab is focused (not while hidden).
- Empty state that says something useful, not "no notifications".

**Acceptance criteria**
- [ ] Given three unread notifications, then the badge shows 3.
- [ ] Given a notification is clicked, then the user lands on the subject and the count
      decreases.
- [ ] Given a background tab, then polling pauses.
- [ ] Given a notification whose subject was deleted or cancelled, then the item renders
      as unavailable rather than erroring.

### P0 — Approvals inbox

- Route `/approvals` with tabs: **Awaiting me** (default), **My requests**, **History**.
- "Awaiting me" lists pending approvals assigned to the current user, oldest first,
  with age prominently displayed.
- **Type-specific context renderers.** Each `subject_type` registers a card renderer;
  the inbox shell is generic. Adding a new approvable type means adding one renderer, not
  a new page.
  - *Leave request*: employee, type, dates, working days, remaining balance after approval,
    overlapping team leave, reason, attachment.
  - *Expense claim*: employee, category, amount, project, **receipt image inline and
    zoomable**, category limit status, line breakdown.
  - *Quote*: customer, total, validity, line items, discount %, link to the rendered document.
  - *Invoice*: customer, total, terms, customer's current AR balance and health (PRD-003).
- Approve / Reject inline with an optional comment; reject requires a comment.
- Optimistic update with rollback on failure, matching the existing deals stage-move pattern.
- Filters by type and requester; search by requester name.

**Acceptance criteria**
- [ ] Given pending approvals of three types, then all appear in one list with correct
      type-specific context.
- [ ] Given approval, then the item leaves the list immediately and the subject's state updates.
- [ ] Given a failed approval (409 already decided), then the optimistic update rolls back
      and a clear message explains the item was already handled.
- [ ] Given a rejection without a comment, then the action is blocked with an inline message.
- [ ] Given a user with nothing pending, then a genuine empty state renders.
- [ ] Given a new `subject_type` with no registered renderer, then a generic fallback card
      renders rather than crashing.

### P0 — Requester visibility

- "My requests" tab: everything the user has submitted, with current state, approver name,
  time waiting.
- Nudge action on a request pending beyond a threshold — sends a reminder notification to
  the approver. Rate-limited to prevent nagging.
- Cancel action on own pending requests.

**Acceptance criteria**
- [ ] Given a submitted request, then the requester sees the approver's name and elapsed time.
- [ ] Given a nudge, then the approver receives one notification; a second nudge within
      24h is blocked.
- [ ] Given cancellation, then the approval is `cancelled` and disappears from the
      approver's list.

### P0 — Mobile responsiveness for approvals

- `/approvals` and the notification bell must be fully usable at 375px width.
- Approval cards stack; receipt images are tappable to full screen; Approve/Reject are
  large touch targets.
- **This is the only part of the console with a hard mobile requirement in this PRD.**
  Approvers are on phones; everyone else is at a desk.

**Acceptance criteria**
- [ ] Given a 375px viewport, then an approval can be reviewed and decided without
      horizontal scrolling.
- [ ] Given a receipt image on mobile, then it opens full screen and is zoomable.

### P0 — Dashboard integration

- "Needs your attention" tile on the existing dashboard, linking to the inbox.
- Included in the existing KPI tile layout, not a new page.

### P1

- Bulk approve within a single type, with a confirmation showing the total impact
  (e.g. "approve 5 claims totalling RM3,400").
- Notification preferences (in-app / in-app + email digest).
- Keyboard shortcuts for rapid review (j/k navigate, a approve, r reject).
- Approval delegation while on leave — the People module knows who is away, which makes
  this a natural compound feature.
- Approval SLA: flag requests pending beyond N days; report on approver responsiveness.

### P2 (design for, do not build)

- Approve via email or WhatsApp reply with a signed one-time token.
- Multi-step chain visualisation once PRD-000 supports chains.
- An agent that pre-reviews approvals and recommends a decision with reasoning —
  the natural next agent after collections, and the reason to keep every approval
  decision on the event bus with full context.

## Success Metrics

- A manager can decide on a leave request in under 30 seconds from notification to
  decision, on a phone. Time this manually; it is the metric that determines whether the
  workflow survives contact with real users.
- Every approvable type in the system is decidable from the inbox without navigating to
  its module.
- Adding a new approvable type costs one renderer file and no changes to the inbox shell.

## Open Questions

- **(Product, blocking)** Should approval require re-authentication for high-value items
  (invoices or quotes above a threshold)? Adds friction; adds defensibility. Probably not
  in v1, but decide deliberately rather than by omission.
- **(Design, non-blocking)** Notification bell versus a persistent sidebar count — the
  bell is conventional, but the sidebar is more visible for infrequent console users, and
  managers will be exactly that.
- **(Product, non-blocking)** Should the "Needs your attention" tile include non-approval
  items (overdue invoices assigned to you, breached-SLA tickets)? Broader is more useful
  and risks becoming a second dashboard.

## Timeline Considerations

Hard-blocked on PRD-000's approvals and notifications API. Should ship **in the same
release** as PRD-000 — an approvals backend with no inbox is not a shippable increment,
and the primitive's design will be validated only when a real screen consumes it.

Renderers for leave and claims ship with PRD-006; the quote renderer ships with PRD-004.
Build the shell plus a generic fallback card first so those PRDs plug in without
touching this one.
