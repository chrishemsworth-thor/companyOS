-- PRD-006c (S7) — leave requests, approval and the team calendar.
--
-- ## Why 0026 and not 0024
--
-- S5 (expense claims), S6 (leave policy) and S7 (this) are being built
-- concurrently from the same `main`, whose highest migration is 0023. All three
-- would otherwise take 0024, and `0015` is already duplicated once
-- (`0015_google_accounts.sql` / `0015_people.sql`) — SESSION-PLAN standing rule
-- 5 explicitly forbids a third collision. So the numbers are reserved by
-- session order: **0024 = S5 claims, 0025 = S6 leave policy, 0026 = S7 (here)**.
-- If S6 lands on a different number that is harmless; nothing below references
-- it.
--
-- ## What S7 owns, and what it deliberately does not
--
-- S6 owns the *entitlement* side of leave — `leave_types`, `leave_policies`,
-- tenure bands, accrual, pro-rating, carry-forward, `public_holidays` and the
-- configurable work week. S7 owns the *consumption* side, which is this one
-- table. The split falls straight out of PRD-006's balance formula:
--
--     available = entitlement + carry_forward − taken − pending
--                 └────── S6 owns ──────────┘   └── S7 owns ──┘
--
-- `taken` and `pending` are both derived from the rows below, which is why S7
-- needs no balance table and why approving a request does not decrement
-- anything: a pending→approved transition moves days from the "pending" bucket
-- to the "taken" bucket and leaves `available` unchanged. See
-- docs/modules/leave.md.
--
-- ## leave_type_code is a CODE, not a foreign key
--
-- The obvious column would be `leave_type_id REFERENCES leave_types(...)`. It
-- is deliberately not, because `leave_types` is S6's table and does not exist on
-- this branch. Storing the tenant-scoped code decouples the two migrations
-- completely, so S6 and S7 can land in either order and neither blocks the
-- other. The code is resolved through src/modules/people/leave/policy-port.ts,
-- which reads S6's tables when they are present and falls back to provisional
-- defaults when they are not.
--
-- This is the same reasoning `approvals.subject_type` and `files.purpose` use
-- for staying unconstrained TEXT: the consumer owns the vocabulary, we own the
-- lifecycle. `state` below therefore DOES carry a CHECK — it is this module's
-- own vocabulary and nothing extends it.

CREATE TABLE leave_requests (
  leave_request_id   TEXT NOT NULL,               -- lvr_01J...
  tenant_id          TEXT NOT NULL REFERENCES tenants(tenant_id),
  -- Leave is always ABOUT an employee, never about a user: an employee with no
  -- console login can still have leave filed for them by HR. The requesting
  -- user is `created_by` and is nullable for the same reason `files.uploaded_by`
  -- is — a tenant-API-key caller has no user identity.
  employee_id        TEXT NOT NULL,
  -- S6's leave_types.code (annual, sick, hospitalisation, ...). Not an FK — see
  -- the note above.
  leave_type_code    TEXT NOT NULL,
  start_date         TEXT NOT NULL,               -- ISO date YYYY-MM-DD
  end_date           TEXT NOT NULL,               -- inclusive
  -- Half-day support (PRD-006: "start/end (half-day supported)"). The minimum
  -- that works is a half day at either end of the span, which covers the real
  -- cases — a Friday afternoon off, or leave that resumes at midday. A
  -- half-day-per-arbitrary-day model would need a child table and nobody has
  -- asked for one.
  start_half_day     INTEGER NOT NULL DEFAULT 0 CHECK (start_half_day IN (0, 1)),
  end_half_day       INTEGER NOT NULL DEFAULT 0 CHECK (end_half_day IN (0, 1)),
  -- Working days as computed AT SUBMISSION from the applicable work week and
  -- holiday set, then frozen. Stored rather than recomputed on read so the
  -- number the employee was shown before submitting is the number that gets
  -- deducted — a tenant editing its holiday set in March must not silently
  -- change what somebody already had approved in January. REAL because half
  -- days make it fractional.
  working_days       REAL NOT NULL,
  reason             TEXT,
  -- Optional, except on leave types whose policy requires one (medical
  -- certificates). files(file_id) with purpose = 'leave_attachment'; not a
  -- composite FK because `files` is keyed by file_id alone, the same reason
  -- `employees.user_id` cannot carry one.
  attachment_file_id TEXT,
  -- Lifecycle. `cancellation_pending` exists to implement PRD-006's
  -- "cancelling an approved future leave requires re-approval or admin action"
  -- literally: the employee's cancellation of already-approved leave raises a
  -- SECOND approval rather than taking effect immediately, and the decision
  -- handler tells the two apart by the state it finds the row in. No extra
  -- column needed for that.
  --
  --   pending              → approved | rejected | cancelled
  --   approved             → cancellation_pending | cancelled (admin only)
  --   cancellation_pending → cancelled | approved (re-approval rejected)
  --   rejected, cancelled  → terminal
  state              TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'rejected', 'cancellation_pending', 'cancelled')),
  -- The approvals row currently driving this request. Repointed when a
  -- cancellation raises a second approval, so it always names the live one;
  -- the full decision history lives in `approvals` itself, which is the audit
  -- record PRD-000 asks for.
  approval_id        TEXT,
  decided_at         TEXT,
  cancelled_at       TEXT,
  created_by         TEXT REFERENCES users(user_id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, leave_request_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, employee_id)
);

-- The balance query ("what has this employee taken and what is pending this
-- year") and the same-employee overlap check that returns 409 on submit. Both
-- filter on employee + state and range over start_date, so one index serves
-- both.
CREATE INDEX idx_leave_requests_employee
  ON leave_requests (tenant_id, employee_id, state, start_date);
-- The team calendar: every request overlapping a month, across employees.
CREATE INDEX idx_leave_requests_span
  ON leave_requests (tenant_id, start_date, end_date);
-- "What is outstanding" — the HR list filtered by state.
CREATE INDEX idx_leave_requests_state
  ON leave_requests (tenant_id, state, start_date);
-- An invariant guard, not a lookup path: one approval drives at most one leave
-- request, and enforcing that in SQL means a bug that repointed two requests at
-- the same approval fails loudly instead of producing two rows that transition
-- together. (The decision consumer resolves by `subject_id` off the event
-- payload, so it does not need this index.) NULLs are distinct in SQLite unique
-- indexes, so rows with no live approval never collide.
CREATE UNIQUE INDEX idx_leave_requests_approval
  ON leave_requests (tenant_id, approval_id);
