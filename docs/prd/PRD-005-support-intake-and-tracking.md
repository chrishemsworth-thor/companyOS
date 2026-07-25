# PRD-005 — Support: Customer-Facing Intake & Tracking

**Status:** Partially built (tickets, state machine, threading ✅) · **Priority:** P1
**Depends on:** PRD-000 (file storage, for attachments) — partial

---

## Problem Statement

The Support module has tickets with priorities, an explicit state machine with legal-
transition enforcement, and append-only threaded messages. What it does not have is a
way for the **end customer** to raise or track a ticket.

Every write path requires a tenant API key. That key belongs to the CompanyOS tenant,
not to their customers — so today the only way a ticket exists is if a tenant employee
types it in. That makes Support a ticket *log*, not a helpdesk. The tenant's customers
still email or WhatsApp, someone re-keys it, and the module adds work rather than
removing it.

The pieces to close this are mostly built: Gmail inbound polling already emits
`email.received` events, and the delivery port already sends. What is missing is the
routing between them and an unauthenticated intake surface.

## Goals

1. A tenant's customer can raise a ticket without a CompanyOS login, through the channel
   they already use.
2. Inbound email to a tenant's shared inbox becomes a ticket automatically, with replies
   threading onto the existing ticket rather than creating duplicates.
3. A customer can check status and reply without an account.
4. Tickets carry enough structure (assignee, SLA due, attachments) that a support agent
   in a later phase has something to reason over.
5. API-based intake works for tenants embedding a form in their own product.

## Non-Goals

- **A SupportAgent.** Deliberately out of scope — this PRD builds the substrate the
  agent will consume. Agent behaviour is its own PRD.
- **Live chat / widget.** Higher effort, lower Malaysian SME demand than email and
  WhatsApp.
- **Knowledge base / help centre.** Separate initiative.
- **Full customer portal (invoices, quotes, tickets in one login).** P2 — worth designing
  toward, too big for this PRD.
- **CSAT surveys.** P1 at most.
- **Complex SLA policies with business-hours calendars and pause states.** v1 is a
  simple due timestamp.

## User Stories

- As a tenant's customer, I want to email support@ and have it become a tracked ticket
  so that my request is not lost in someone's inbox.
- As a tenant's customer, I want to reply to the email thread and have it land on the
  same ticket so that context is preserved.
- As a tenant's customer, I want a link to check my ticket's status without a login so
  that I do not have to ask for an update.
- As a support operator, I want tickets assigned to a person with a due time so that I
  know what is mine and what is late.
- As a tenant developer, I want to create tickets from my own app via a scoped token so
  that my in-product support form feeds CompanyOS.
- As a support operator, I want the customer's attachments on the ticket so that I can
  see the screenshot they sent.

## Requirements

### P0 — Email-to-ticket

- Consume the existing `email.received` event stream from the Gmail shared-inbox
  integration.
- Routing rules per tenant: map a shared inbox address to a ticket queue/default priority.
- **Threading**: embed a ticket reference in outbound reply subject and headers
  (`References` / `In-Reply-To` where available, plus a `[#TKT-1234]` subject token as
  fallback). Inbound mail matching an existing ticket appends a message; unmatched mail
  creates a new ticket.
- Sender matching: if the From address matches a known contact, link the ticket to that
  customer; otherwise create the ticket unlinked with the raw sender recorded.
- Replying to a resolved ticket re-opens it (existing behaviour — verify it fires on
  the email path too).
- Loop protection: ignore auto-replies (`Auto-Submitted`, `Precedence: bulk`), and never
  reply to a no-reply address.

**Acceptance criteria**
- [ ] Given an email to a mapped shared inbox, then a ticket is created with the subject
      as title and the body as the first message.
- [ ] Given a reply to a CompanyOS ticket notification, then the message appends to the
      existing ticket and no duplicate is created.
- [ ] Given an out-of-office auto-reply, then no ticket is created and no reply is sent.
- [ ] Given an email from an unknown sender, then a ticket is created with sender email
      recorded and `customer_id` null.
- [ ] Given the same email delivered twice by Gmail history polling, then only one
      ticket/message results (idempotent on message id).

### P0 — Public intake endpoint

- `POST /public/tickets` authenticated by a **per-tenant public intake token**, distinct
  from the tenant API key and safe to embed in a tenant's own frontend.
- Scoped to ticket creation only. Rate limited per token and per IP. Revocable and
  regenerable from Settings.
- Optional hCaptcha/Turnstile hook for tenants embedding on public pages.

**Acceptance criteria**
- [ ] Given a valid intake token, then a ticket is created and the token cannot be used
      for any other endpoint (verify explicitly — this is the security-critical test).
- [ ] Given a revoked token, then 401.
- [ ] Given rate-limit breach, then 429.

### P0 — Public ticket tracking

- `GET /t/:token` — unauthenticated tracking page showing status, message thread, and a
  reply box. Token is per-ticket, high-entropy, hashed at rest.
- Link included in every outbound ticket notification.
- Customer replies via the page append as `author = customer` and re-open resolved tickets.
- Internal notes are **never** shown on this page — add an `is_internal` flag to messages
  and default it correctly. Leaking an internal note to a customer is the failure mode
  that would kill trust in the module.

**Acceptance criteria**
- [ ] Given a valid ticket token, then the customer sees the public thread only.
- [ ] Given a message flagged internal, then it never appears on the public page (assert
      on the API response, not just the UI).
- [ ] Given a customer reply on a resolved ticket, then the ticket re-opens and the
      assignee is notified.

### P0 — Assignment and SLA basics

- `assignee_user_id` on tickets; assignment emits `ticket.assigned.v1` and notifies
  (PRD-000 notifications).
- `due_at` computed from priority-based response targets in tenant settings.
- Overdue tickets flagged; a cron sweep emits `ticket.sla_breached.v1` — mirroring the
  invoice overdue sweep pattern, which the future SupportAgent will consume.

**Acceptance criteria**
- [ ] Given a high-priority ticket, then `due_at` reflects the configured target.
- [ ] Given a ticket past `due_at` and unresolved, then the sweep emits a breach event once.
- [ ] Given assignment, then the assignee receives a notification.

### P0 — Attachments

- Attachments on ticket messages via PRD-000 file storage.
- Inbound email attachments captured where the Gmail integration provides them.
- Public tracking page allows customer uploads, with stricter size/type limits than the
  authenticated path.

**Acceptance criteria**
- [ ] Given an inbound email with an image attachment, then it is stored and visible on
      the ticket.
- [ ] Given an oversized or disallowed public upload, then it is rejected with a clear message.

### P1

- WhatsApp inbound → ticket (Twilio integration already sends; inbound webhook is the
  missing half). Likely higher value than the public form for Malaysian SMEs.
- Ticket categories/tags and per-category routing.
- Canned responses.
- CSAT on resolution.
- Linking tickets to invoices or deals (the cross-module play — a billing dispute ticket
  that pauses collections).

### P2 (design for, do not build)

- SupportAgent: triage, categorise, draft replies, auto-resolve routine tickets.
  Keep every ticket event on the bus with full context so the agent needs no new plumbing.
- Unified customer portal.
- Business-hours SLA calendars with pause on `pending`.

## Success Metrics

- A customer email lands as a ticket, gets a reply, and threads correctly — end to end
  with no operator re-keying.
- Zero internal-note leakage in the public path (assert in tests).
- Ticket volume per customer feeds CRM health (PRD-003) without additional work.

## Open Questions

- **(Product, blocking)** WhatsApp inbound before or after the public form? WhatsApp is
  how Malaysian SME customers actually complain, which argues for doing it first — but it
  needs a BSP relationship and Twilio inbound webhook config.
- **(Engineering, blocking)** Does the current Gmail integration expose message
  `References`/`In-Reply-To` headers, or only body and metadata? Threading quality
  depends on it; the subject-token fallback is materially worse.
- **(Engineering, non-blocking)** Should intake tokens reuse the designed-but-unbuilt
  scoped API key work, or ship as a purpose-built token first? Purpose-built is faster;
  scoped keys are the right long-term home.

## Timeline Considerations

Email-to-ticket depends on the existing Gmail integration and is the highest-value item.
Attachments depend on PRD-000.

Suggested order: threading + email-to-ticket → public tracking page (with the internal-note
flag) → assignment/SLA → attachments → public intake token.
