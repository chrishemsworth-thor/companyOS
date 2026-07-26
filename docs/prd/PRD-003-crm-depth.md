# PRD-003 — CRM: Contact Roles, Customer Depth, Health

**Status:** Partially built · **Priority:** P1
**Depends on:** PRD-001 (customer dimension improves health signals)

---

## Problem Statement

A customer can already have multiple contacts, but contacts are undifferentiated —
there is no way to express that Aina is the person who signs quotes, Ravi is the
person who pays invoices, and Wei Ming is the day-to-day user. This has a direct
operational cost: the CollectionsAgent picks a contact without knowing who actually
controls payment, which is a common reason reminders are ignored, and quote signing
(PRD-004) has no way to identify an authorised signatory.

Separately, the customer record is thin on the attributes a Malaysian B2B seller needs
(SSM registration number, payment terms, credit limit) and does not surface a
consolidated view of customer health, despite CompanyOS holding every input for it —
payment behaviour, support load, and pipeline in one database.

The temptation here is field-bloat and Apollo parity. Both are the wrong response.
The differentiator is not more fields; it is that the CRM record knows things no
standalone CRM can know.

## Goals

1. Every contact has an explicit role, and agents and documents route to the right
   person by role rather than by guess.
2. The customer record carries the commercial attributes required to sell B2B in
   Malaysia (registration number, payment terms, credit limit).
3. A customer health signal derived from payment behaviour, support load, and pipeline
   is available to humans and agents through one field.
4. Contact-role data measurably improves collections targeting (measured via eval
   scenarios in PRD-002).

## Non-Goals

- **Building a contact database / Apollo competitor.** We will never out-scale a
  250M-record licensed database, and Apollo's Malaysian SME coverage is thin.
  Enrichment stays a pluggable port — bring your own provider.
- **Email sequencing engine.** Belongs in the SalesAgent PRD, not here.
- **Custom fields / field builder.** Premature and a permanent maintenance tax. Revisit
  when a design partner is actually blocked by a missing field.
- **Company hierarchy (parent/subsidiary).** P2 — Malaysian SMEs rarely need it.
- **Duplicate detection and merge.** P1 at most; not a v1 problem with no data.

## User Stories

- As a finance operator, I want to mark one contact as the billing contact so that
  invoices and reminders go to the person who can actually pay.
- As the CollectionsAgent, I want to know the billing contact so that I stop chasing
  the wrong person.
- As a sales operator, I want to record a customer's payment terms so that invoice due
  dates are set correctly without me remembering.
- As an account manager, I want to see at a glance that a customer has two overdue
  invoices and an unresolved ticket so that I do not walk into a renewal conversation
  blind.
- As a sales operator, I want the customer's SSM number on the record so that quotes
  and invoices carry legally correct entity details.

## Requirements

### P0 — Contact roles

- Add `roles` to contacts: multi-valued from `primary`, `billing`, `technical`,
  `signatory`, `other`. A contact may hold several; a customer may have several
  contacts per role.
- Exactly one contact per customer may be marked `is_primary` (enforced).
- Resolution helper `resolveContact(customerId, role)` with a documented fallback
  chain: requested role → primary → any contact. Used by the CollectionsAgent, invoice
  delivery, and quote signing.
- Existing contacts migrate to `primary` on the first (by created_at) and `other` on
  the rest — a safe default, not a guess at intent.
- Console: role selection on contact create/edit, role badges in the contact list.

**Acceptance criteria**
- [ ] Given a customer with a billing contact, when a reminder is sent, then it
      addresses the billing contact.
- [ ] Given a customer with no billing contact, then the reminder falls back to primary
      and the fallback is recorded on the decision.
- [ ] Given an attempt to set a second `is_primary` contact, then the previous primary
      is cleared atomically (or 409 — pick one and test it).
- [ ] Given a customer with zero contacts, then reminder dispatch fails gracefully with
      a `customer.no_contact` event rather than throwing.

### P0 — Customer commercial attributes

Add to the customer record:
- `registration_no` (SSM), `tax_id` (SST registration), `industry`, `website`
- `payment_terms_days` (default from tenant settings) — **used to compute invoice due
  dates automatically**, which is the point of storing it
- `credit_limit_cents` (nullable)
- `billing_address` and `shipping_address` as structured fields (currently likely
  free text — required for correct invoice rendering)
- `preferred_channel` (email / whatsapp) — consumed by the delivery port
- `notes` (long text)

**Acceptance criteria**
- [ ] Given a customer with 45-day terms, when an invoice is created without an explicit
      due date, then due date is issue date + 45 days.
- [ ] Given a customer with a credit limit, when a new invoice would exceed outstanding
      AR + limit, then the console warns (warn only — do not block).
- [ ] Given structured addresses, then the rendered invoice and quote documents use them.

### P0 — Customer health

- Derived, not stored: computed on read from existing data.
  Inputs: days-sales-outstanding vs terms, count/age of overdue invoices, open ticket
  count and age, last activity recency, open deal value.
- Output: a band (`good` / `watch` / `at_risk`) plus the contributing reasons as a list.
  **Reasons matter more than the score** — "2 invoices 60+ days overdue, 1 ticket open
  14 days" is actionable; a number is not.
- Exposed on `GET /v1/customers/:id` and in the CollectionsAgent context assembly.
- Console: health badge on the customer list and a reasons panel on the detail page.

**Acceptance criteria**
- [ ] Given a customer with two invoices 60+ days overdue, then health is `at_risk`
      with both invoices named in the reasons.
- [ ] Given a customer paying on time with no tickets, then health is `good`.
- [ ] Given a new customer with no history, then health is `good` with an explicit
      "insufficient history" reason rather than a misleading score.
- [ ] Given the health computation, then it adds no more than one additional query to
      the customer detail endpoint.

### P1

- Contact-level activity attribution (which contact was on the call).
- Duplicate customer detection on create (name/registration number similarity), warn only.
- Customer segments / tags with filtering.
- Health trend over time (requires a periodic snapshot table).

### P2 (design for, do not build)

- Parent/subsidiary company hierarchy — keep `customer_id` as the only FK so a
  `parent_customer_id` is additive.
- Malaysian firmographic enrichment from SSM registry data. Legally and commercially
  a separate product; note it, do not start it.
- Custom fields.

## Success Metrics

- CollectionsAgent eval scenarios (PRD-002) that include a billing contact route to it
  100% of the time.
- A customer detail page answers "should I be worried about this account?" without
  clicking into another module.
- No increase in customer-detail endpoint p95 latency beyond 50ms from health computation.

## Open Questions

- **(Product, blocking)** Should `at_risk` health automatically pause outbound sales
  activity, or only surface as a signal? Automatic pausing is the more impressive
  compound behaviour and the more dangerous one.
- **(Product, non-blocking)** Is credit limit worth building before a customer asks?
  It is cheap to store and easy to ignore, but the enforcement UX is a rabbit hole.
- **(Engineering, non-blocking)** Health computed per request vs cached with TTL —
  start per-request, measure, cache only if needed.

## Timeline Considerations

Contact roles are the highest-value, lowest-cost item here and unblock PRD-004
(signatory identification) and improve PRD-002 outcomes. Do roles first, ship it, then
decide whether attributes and health are still the right next thing.

Health depends on PRD-001 only loosely; it works on existing data and improves with
ledger dimensions.
