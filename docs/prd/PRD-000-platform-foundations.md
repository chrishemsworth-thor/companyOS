# PRD-000 — Platform Foundations: File Storage, Approvals, Notifications

**Status:** Not started · **Priority:** P0, blocks PRD-004, PRD-006, PRD-007
**Owner:** Chris · **Target:** before any module work resumes

---

## Problem Statement

Three separate planned features — quote signing with logos, expense claims with
receipt images, and manager approval of leave/claims/quotes — each independently
require the ability to store binary files, route a request to a human approver,
and notify that human that something is waiting. None of these three capabilities
exist in CompanyOS today.

If each module builds its own version, we end up with three incompatible approval
tables, three notification mechanisms, and no single place for a user to see
"what needs my attention." Building these once as platform primitives is
significantly cheaper than retrofitting later, and must happen before the
dependent module PRDs start.

## Goals

1. Any module can store and retrieve a tenant-scoped file with a single service
   call, with no module-level knowledge of the storage backend.
2. Any module can request approval of any entity type without adding module-specific
   approval tables.
3. A console user has one place that shows everything awaiting their action.
4. Approver resolution reuses the existing People reporting lines rather than a
   parallel org structure.
5. No regression in existing test suites; all three primitives covered by new
   Workers-runtime Vitest suites.

## Non-Goals

- **Multi-step / parallel approval chains.** v1 is single-approver. Sequential
  escalation is P2 — designed for, not built.
- **Real-time push (WebSockets / Durable Object fanout).** Polling on console
  load is sufficient at current scale.
- **Mobile push notifications.** No mobile app exists.
- **A generic workflow engine.** This is an approvals table, not BPMN.
- **File versioning.** Uploads are immutable; a new file is a new object.

## User Stories

**Storage**
- As a developer, I want to upload a file and receive a stable reference so that any
  module can attach documents without knowing about R2.
- As an admin, I want files from another tenant to be unreachable so that tenant
  isolation holds for binaries as it does for rows.

**Approvals**
- As an employee, I want my leave request routed automatically to my manager so that
  I do not have to know who approves what.
- As a manager, I want to approve or reject with an optional comment so that the
  requester understands the decision.
- As an auditor, I want every approval decision permanently recorded with actor and
  timestamp so that the record is defensible.

**Notifications**
- As a manager, I want a badge showing how many items await my action so that I do
  not need to check each module.
- As a user, I want to mark notifications read so that the list reflects reality.

## Requirements

### P0 — File storage

- R2 bucket bound to the Worker. Single `files` table:
  `id, tenant_id, key, filename, content_type, size_bytes, sha256, uploaded_by,
  created_at, purpose` where `purpose` is an enum (`quote_logo`, `claim_receipt`,
  `signature`, `other`).
- `POST /v1/files` — multipart upload. Returns file id.
- `GET /v1/files/:id` — streams content. **Tenant-scoped auth required.** Object key
  MUST be prefixed `{tenant_id}/{uuid}` and the handler MUST verify the row's
  `tenant_id` matches the caller before streaming. Never trust the key alone.
- `DELETE /v1/files/:id` — soft delete row, delete R2 object.
- Limits: 10 MB max, allowlist `image/png`, `image/jpeg`, `image/webp`,
  `application/pdf`. Reject others with 415.
- Store SHA-256 of content (needed by PRD-004 for signature integrity).

**Acceptance criteria**
- [ ] Given a file uploaded by tenant A, when tenant B requests it by id, then 404
      (not 403 — do not confirm existence).
- [ ] Given a 12 MB upload, then 413 with a clear message.
- [ ] Given an `application/zip` upload, then 415.
- [ ] Given a deleted file, when fetched, then 404 and the R2 object is gone.

### P0 — Approvals primitive

- `approvals` table: `id, tenant_id, subject_type, subject_id, requested_by,
  approver_user_id, state (pending|approved|rejected|cancelled), decision_comment,
  decided_by, decided_at, created_at, idempotency_key`.
- `subject_type` is an enum, extended per consuming module:
  `leave_request`, `expense_claim`, `quote`, `invoice`.
- Service API (internal, not HTTP): `requestApproval(subject)`,
  `decide(approvalId, decision, comment)`, `cancel(approvalId)`.
- HTTP: `GET /v1/approvals?state=pending&mine=true`, `POST /v1/approvals/:id/approve`,
  `POST /v1/approvals/:id/reject`.
- **Approver resolution** is a pluggable strategy per `subject_type`. Default
  strategy: the employee's manager via existing People reporting lines. Fallback
  when no manager is set: any user with role `admin`. Quote/invoice approval uses
  a role-based strategy (`admin` or `finance`).
- Emit `approval.requested.v1`, `approval.approved.v1`, `approval.rejected.v1`
  through the existing event bus (register in the schema registry with Zod schemas).
- Decisions are **terminal** — a decided approval cannot be re-decided. Return 409
  listing the current state, matching the existing Support state-machine convention.
- Self-approval blocked unless the approver holds role `admin`.

**Acceptance criteria**
- [ ] Given a pending approval, when the assigned approver approves, then state is
      `approved`, `decided_by`/`decided_at` are set, and `approval.approved.v1` is emitted.
- [ ] Given an approved approval, when approved again, then 409 with current state.
- [ ] Given a user who is not the approver and not admin, when they decide, then 403.
- [ ] Given an employee with no manager, when approval is requested, then it routes
      to a tenant admin.
- [ ] Given a requester who is also the resolved approver and is not admin, then the
      request routes to the next level up, or to an admin if none.
- [ ] Given a cancelled subject (e.g. withdrawn leave request), then the approval is
      `cancelled` and no longer appears in pending lists.

### P0 — Notifications

- `notifications` table: `id, tenant_id, user_id, type, subject_type, subject_id,
  title, body, read_at, created_at`.
- Generated by an **event consumer**, not by module code. Consumes
  `approval.requested.v1`, `approval.approved.v1`, `approval.rejected.v1` and creates
  rows for the relevant users. New notification types are added by extending the
  consumer's event→notification mapping.
- `GET /v1/notifications?unread=true`, `POST /v1/notifications/:id/read`,
  `POST /v1/notifications/read-all`.
- Console: bell icon with unread count, dropdown list, each item deep-links to its
  subject. Poll on route change and every 60s while the tab is focused.

**Acceptance criteria**
- [ ] Given an approval request is created, then the approver has an unread notification
      within one event-bus round trip.
- [ ] Given the free-plan inline event fallback (`wrangler.free.jsonc`), then notification
      creation still works.
- [ ] Given a notification is marked read, then the unread count decreases and it does
      not reappear on refresh.
- [ ] Given a user from tenant B, then tenant A's notifications are never returned.

### P1

- Email fanout for pending approvals via the existing `DeliveryProvider` port,
  respecting per-tenant delivery opt-in. Daily digest rather than per-event to
  avoid noise.
- Notification preferences per user (in-app only / in-app + email).

### P2 (design for, do not build)

- Multi-step sequential approval chains — keep `approvals` rows independent so a
  `sequence_index` and `parent_id` can be added without migration pain.
- Approval delegation during leave.
- WhatsApp approval replies.

## Success Metrics

Pre-customer, so these are engineering-quality metrics:
- All three primitives have Workers-runtime test suites; no dependent PRD adds its
  own approval or notification table.
- PRD-004, 006, 007 each consume the primitive with zero schema additions to
  `approvals` beyond a `subject_type` enum value.

## Open Questions

- **(Engineering, blocking)** Does the current free-plan inline fallback path handle
  a consumer that writes rows, or is it fire-and-forget? Notifications depend on it.
- **(Engineering, non-blocking)** R2 in the same account/region as D1 — confirm no
  cross-region latency on receipt image loads.
- **(Product, non-blocking)** Should a rejected leave request be editable and
  resubmitted, or must the employee create a new one? Affects whether `approvals`
  needs a `supersedes` column.

## Timeline Considerations

Hard blocker for PRD-004 (quote signing), PRD-006 (leave/claims), PRD-007
(console approvals UI). Suggested phasing within this PRD:

1. Files (independent, smallest)
2. Approvals table + service + HTTP
3. Notification consumer + console bell

Phases 2 and 3 should land together — an approval nobody is told about is not a
feature.
