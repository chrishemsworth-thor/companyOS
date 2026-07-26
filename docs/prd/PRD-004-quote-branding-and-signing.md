# PRD-004 — Quotes: Branded Documents & Click-to-Sign

**Status:** Partially built (rendering + branding settings ✅) · **Priority:** P1
**Depends on:** PRD-000 (file storage, approvals), PRD-003 (signatory contact role)

---

## Problem Statement

Quotes render as server-side HTML with per-tenant branding settings, and convert to
invoices in one call. Two gaps stop this being usable in a real sale: the tenant cannot
upload a logo (branding is config-only), and acceptance is recorded by an operator
clicking "accepted" in the console rather than by the customer actually agreeing to
anything.

That second gap is the important one. Today a CompanyOS quote has no evidentiary value —
there is no record that the customer saw the document, when, or that they agreed to its
specific contents. SMEs currently solve this by emailing a PDF and waiting for a
reply-with-"confirmed", or by paying for a separate e-signature tool. Closing this loop
inside the quote-to-cash path is a concrete reason to use CompanyOS over a stack.

## Goals

1. A quote looks like it came from the tenant's business, not from a generic SaaS.
2. A customer can accept a quote from a link, without a login, in one click.
3. Acceptance produces an audit record strong enough to rely on commercially.
4. A signed quote is immutable — the artifact signed is the artifact stored.
5. Internal sign-off (an authorised person approving before a quote goes out) is
   supported via the PRD-000 approvals primitive.

## Non-Goals

- **DSA-1997-certified digital signatures via a licensed CA.** Malaysia's Electronic
  Commerce Act 2006 recognises electronic signatures for ordinary commercial contracts;
  certified digital signatures are only required where statute demands them, and
  building to that bar means integrating a licensed CA for negligible SME benefit.
  *(Confirm with a Malaysian lawyer before relying on this — it is a product decision,
  not legal advice.)*
- **A general document-signing product.** Scope is quotes, with the pattern reusable
  for invoices and contracts later.
- **Multi-party / counter-signing.** One customer signatory in v1.
- **PDF generation.** HTML rendering plus browser print-to-PDF is sufficient; a real
  PDF pipeline is P1.
- **Template designer / WYSIWYG editor.** Config-driven templates only.

## User Stories

- As a tenant admin, I want to upload my company logo so that quotes carry my brand.
- As a customer, I want to open a quote link and accept it without creating an account
  so that agreeing takes ten seconds.
- As a sales operator, I want to know exactly when the customer opened and accepted the
  quote so that I can stop chasing.
- As a tenant admin, I want quotes above a threshold to need my approval before sending
  so that junior staff cannot commit the company to bad pricing.
- As a finance operator, I want an accepted quote to convert to an invoice carrying the
  acceptance record so that the audit trail survives.

## Requirements

### P0 — Logo and branding assets

- Logo upload via PRD-000 file storage (`purpose = quote_logo`), referenced from
  tenant branding settings.
- Rendered in the quote document header; also used on invoices and credit notes.
- Constraints: PNG/JPEG/WebP, ≤ 2 MB, recommended dimensions documented.
- Optional accent colour and footer text (terms, bank details, registration numbers)
  in branding settings.

**Acceptance criteria**
- [ ] Given a logo is uploaded, then it appears on the rendered quote and invoice.
- [ ] Given no logo, then the document renders cleanly with the company name only.
- [ ] Given a logo request from an unauthenticated public quote link, then the image is
      served without exposing the tenant's other files (scoped public read for
      `quote_logo` purpose only).

### P0 — Public quote link

- `GET /q/:token` — unauthenticated, token-addressed public view of a quote.
- Token is a high-entropy random value, not the quote id. Stored hashed.
- Optional expiry aligned with the quote's own expiry; expired links render an
  "expired" state, not a 404.
- Records a `quote.viewed.v1` event on first view (IP, user agent, timestamp).
- Tenant can revoke a link.

**Acceptance criteria**
- [ ] Given a valid token, then the quote renders with branding and no console chrome.
- [ ] Given an expired or revoked token, then an explanatory expired page is shown.
- [ ] Given a guessed/invalid token, then 404 with no information leakage.
- [ ] Given a quote viewed twice, then `quote.viewed.v1` fires once (first view), and
      subsequent views update a `last_viewed_at`.

### P0 — Click-to-sign acceptance

- Accept flow on the public page: signatory enters name and email, optionally types or
  draws a signature, ticks an explicit agreement checkbox, clicks Accept.
- On acceptance, capture an **audit record**: signatory name, email, IP address, user
  agent, UTC timestamp, the agreement text version shown, and the **SHA-256 hash of the
  rendered document**.
- The rendered HTML artifact is frozen to file storage at acceptance time. The stored
  hash must match the stored artifact.
- Drawn/typed signature image stored via PRD-000 (`purpose = signature`) and rendered
  onto the archived artifact.
- Quote moves to `accepted`; emits `quote.accepted.v1`.
- **A quote cannot be edited after being sent.** Changes require a new version. If the
  document can change after signing, the signature is worthless — this is the load-bearing
  requirement of the whole feature.
- Conversion to invoice carries a reference to the acceptance record.
- If the customer has a `signatory` contact (PRD-003), pre-fill and record the match.

**Acceptance criteria**
- [ ] Given a quote is accepted, then the stored artifact's SHA-256 equals the hash in
      the acceptance record.
- [ ] Given a sent quote, when an edit is attempted, then 409 directing the user to
      create a new version.
- [ ] Given an accepted quote, when accepted again, then 409.
- [ ] Given an expired quote, then the Accept action is unavailable.
- [ ] Given acceptance without the agreement checkbox ticked, then the request is rejected.
- [ ] Given an accepted quote converted to an invoice, then the invoice links to the
      acceptance record and the archived artifact remains retrievable.
- [ ] Given the archived artifact, then it renders identically after the tenant changes
      their branding settings.

### P0 — Reject and expire

- Customer can decline with an optional reason → `quote.rejected.v1`.
- Existing cron expiry continues to work; expired quotes cannot be accepted.

### P1 — Internal sign-off (uses PRD-000 approvals)

- Tenant setting: quotes above a value threshold require internal approval before send.
- `subject_type = quote` on the approvals table; approver strategy is role-based
  (`admin` or `finance`).
- Quote cannot transition to `sent` while an approval is pending.

**Acceptance criteria**
- [ ] Given a quote above threshold, when send is attempted, then the quote enters
      `pending_approval` and the approver is notified.
- [ ] Given approval is granted, then the quote can be sent.
- [ ] Given rejection, then the quote returns to draft with the comment attached.

### P1 (other)

- PDF generation for email attachment.
- Quote versioning with a visible version history.
- Reminder to the customer for an unviewed/unaccepted quote (a natural second agent
  behaviour — could reuse the CollectionsAgent pattern).
- Apply signing to invoices and to a generic contract entity.

### P2 (design for, do not build)

- Multi-party counter-signing — keep the acceptance record as a row per signatory so
  this is additive.
- Certified digital signature integration with a licensed Malaysian CA.
- Payment-on-acceptance (accept and pay deposit in one flow).

## Success Metrics

- A quote can go from draft to legally-defensible acceptance without either party
  leaving CompanyOS or using email attachments.
- Archived artifact hash verification passes for every accepted quote in the test suite.
- Zero code paths allow mutation of a sent or accepted quote.

## Open Questions

- **(Legal, blocking before customer use)** Confirm with a Malaysian lawyer that
  click-plus-audit-trail acceptance meets ECA 2006 requirements for the contract types
  SME customers will use, and what the agreement text should say. Do not rely on this
  PRD's summary.
- **(Product, non-blocking)** Should the archived artifact be HTML or PDF? HTML is
  cheaper and already built; PDF is what a customer will forward to their lawyer.
- **(Engineering, non-blocking)** Rate limiting on `/q/:token` — public endpoint,
  needs abuse protection distinct from the authenticated API's limits.

## Timeline Considerations

Blocked on PRD-000 file storage (logo, signature image, artifact archival). The public
link and immutability work can be built in parallel with PRD-000 since it needs no
storage.

Suggested order: immutability rules → public link → acceptance + audit → logo →
internal sign-off.
