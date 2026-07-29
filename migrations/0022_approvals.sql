-- PRD-000b — the approvals primitive.
--
-- One table every module routes approval through, so no consuming PRD ships
-- its own. A row says: somebody asked for a decision on some subject, one
-- named user owes that decision, and once given it is permanent.
--
-- `subject_type` is plain TEXT validated by a Zod enum in the service
-- (src/modules/approvals/types.ts), deliberately NOT a SQL CHECK. PRD-000's
-- success metric requires PRD-004, 006 and 007 each to consume this primitive
-- with *zero* schema additions beyond a subject_type value; a CHECK would turn
-- every new consuming module into a migration. `state`, by contrast, DOES
-- carry a CHECK — it is this primitive's own vocabulary and nobody extends it.
-- That asymmetry is the whole design: consumers own the subject, we own the
-- lifecycle. The codebase uses CHECK freely elsewhere (e.g.
-- `employees.employment_type`), so this is a considered divergence — the same
-- one `0021_files.sql` makes for `purpose`.
--
-- Approvals route to USERS, but reporting lines are between EMPLOYEES and
-- `employees.user_id` is nullable (see SESSION-PLAN conflict C1). So
-- `approver_user_id` is NOT NULL and resolution happens before the insert: the
-- service walks up the reporting chain skipping anyone who cannot log in,
-- terminating at a tenant admin. A row can never name an approver who is
-- unable to act, which is how a request would otherwise sit pending forever.
--
-- Rows are INDEPENDENT of one another. PRD-000 lists multi-step sequential
-- chains as P2 "design for, do not build", and independence is what keeps
-- `sequence_index`/`parent_id` purely additive later.
--
-- There is deliberately no `supersedes` column (SESSION-PLAN conflict C8).
-- PRD-006 answers PRD-000's open question for claims: rejection returns the
-- subject to the requester and resubmission is allowed. A resubmission is a
-- NEW row; the subject already owns its own history, so the linkage exists
-- without the primitive growing a column for it. If PRD-007's inbox turns out
-- to need "this replaces an earlier rejected request", that is a decision to
-- take with the screen in front of you, not here.

CREATE TABLE approvals (
  approval_id      TEXT NOT NULL,                 -- apr_01J...
  tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
  -- Extended per consuming module. See the note above on why this is not a CHECK.
  subject_type     TEXT NOT NULL,                 -- leave_request | expense_claim | quote | invoice | other
  subject_id       TEXT NOT NULL,                 -- opaque to this module; the consumer's own id
  -- Who asked. NULL for programmatic (tenant-API-key) callers, which have no
  -- user identity — the same reason `files.uploaded_by` is nullable.
  requested_by     TEXT REFERENCES users(user_id),
  -- Who owes the decision. NOT NULL: resolution runs first and fails loudly
  -- rather than parking a row on nobody.
  approver_user_id TEXT NOT NULL REFERENCES users(user_id),
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'approved', 'rejected', 'cancelled')),
  decision_comment TEXT,                          -- optional on approve, optional on reject (PRD-000)
  -- Decision attribution. Set together with `state`, and never cleared:
  -- decisions are terminal, so these are the permanent audit record PRD-000's
  -- auditor user story asks for.
  decided_by       TEXT REFERENCES users(user_id),
  decided_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Caller-supplied dedupe key, so a module retrying requestApproval() after a
  -- network failure does not raise a second request for the same subject.
  idempotency_key  TEXT,
  PRIMARY KEY (tenant_id, approval_id)
);

-- "What awaits me, oldest first" — the ?mine=true&state=pending query, which is
-- the one PRD-007's inbox runs on every page load. approval_id is a ULID, so
-- ordering by it IS chronological order and no separate created_at sort is needed.
CREATE INDEX idx_approvals_approver ON approvals (tenant_id, approver_user_id, state, approval_id);
-- "What have I asked for" — PRD-007's My requests tab.
CREATE INDEX idx_approvals_requester ON approvals (tenant_id, requested_by, state, approval_id);
-- "The approval for this claim" — how a consuming module finds its own row,
-- and how it cancels one when the subject is withdrawn.
CREATE INDEX idx_approvals_subject ON approvals (tenant_id, subject_type, subject_id);
-- Retry safety. SQLite treats NULLs as distinct in a unique index, so rows
-- without a key (the common case) never collide with each other.
CREATE UNIQUE INDEX idx_approvals_idempotency ON approvals (tenant_id, idempotency_key);
