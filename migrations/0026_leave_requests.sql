-- PRD-006c (S7) — leave requests, approval and the team calendar.
--
-- ## Why this migration rebuilds a table instead of creating one
--
-- S6 (PRD-006b, migration 0025) and S7 (this) were built concurrently from the
-- same `main` and BOTH defined `leave_requests`. They had to: S6's acceptance
-- criteria include "a pending request reduces available balance immediately"
-- and "a rejected request restores it", and a balance defined as
-- `entitlement + carry_forward − taken − pending` cannot be tested without the
-- thing being consumed. So 0025 shipped the balance-relevant columns and said
-- in its own comment that S7 would add "`reason`, `attachment_file_id`, the
-- approval linkage and the leave.* events additively".
--
-- Additively is what this is, with one wrinkle: SQLite cannot widen a CHECK
-- constraint in place, and `state` has to grow `cancellation_pending`. That
-- forces the standard rebuild — create, copy, drop, rename — rather than a
-- series of ALTER TABLE ADD COLUMN. The rebuild is written to be safe on a
-- populated database (0022_roles_drop_check learned that lesson the hard way):
-- every existing row is carried across.
--
-- ## The two type columns
--
-- 0025 keyed a request to `leave_type_id` (an FK into S6's `leave_types`). S7
-- was written against a branch where `leave_types` did not exist, so it keyed
-- to `leave_type_code` — the tenant-scoped code — precisely so the two
-- migrations could land in either order. Both columns survive here, and they
-- are kept consistent rather than left as alternatives:
--
--   * `leave_type_code` is the write path. S7's service takes a code from the
--     API and stores it; it is NOT NULL because every request has one.
--   * `leave_type_id` is resolved from that code against `leave_types` at
--     insert time and stored alongside. It is NULLABLE for exactly one case —
--     a tenant that has not configured leave types yet, where the policy port
--     is serving provisional defaults and there is no row to point at.
--
-- Carrying both is what actually connects the two halves of the module: S6's
-- balance engine (src/modules/leave/balances.ts) groups consumption by
-- `leave_type_id`, and it now sees the requests S7 writes. Dropping either
-- column would mean one side silently counting nothing.
--
-- ## What S7 owns, and what it deliberately does not
--
-- S6 owns the *entitlement* side of leave — `leave_types`, `leave_policies`,
-- tenure bands, accrual, pro-rating, carry-forward, `public_holidays` and the
-- configurable work week. S7 owns the *consumption* side, which is this one
-- table:
--
--     available = entitlement + carry_forward − taken − pending
--                 └────── S6 owns ──────────┘   └── S7 owns ──┘
--
-- `taken` and `pending` are both derived from the rows below, which is why S7
-- needs no balance table and why approving a request does not decrement
-- anything: a pending→approved transition moves days from the "pending" bucket
-- to the "taken" bucket and leaves `available` unchanged. See
-- docs/modules/leave.md.

CREATE TABLE leave_requests_new (
  leave_request_id   TEXT NOT NULL,               -- lvr_01J...
  tenant_id          TEXT NOT NULL REFERENCES tenants(tenant_id),
  -- Leave is always ABOUT an employee, never about a user: an employee with no
  -- console login can still have leave filed for them by HR. The requesting
  -- user is `created_by` and is nullable for the same reason `files.uploaded_by`
  -- is — a tenant-API-key caller has no user identity.
  employee_id        TEXT NOT NULL,
  -- S6's leave_types.code (annual, sick, hospitalisation, ...). The write path.
  leave_type_code    TEXT NOT NULL,
  -- Resolved from the code against leave_types at insert. NULL only where the
  -- tenant has configured no leave types and the policy port is serving
  -- provisional defaults. See the header note.
  leave_type_id      TEXT,
  start_date         TEXT NOT NULL,               -- ISO date YYYY-MM-DD
  end_date           TEXT NOT NULL,               -- inclusive
  -- Half-day markers on the boundary days only: a leave run is whole days in
  -- the middle by definition. Both may be set on a single-day request, which is
  -- how a 0.5-day request is expressed.
  start_half_day     INTEGER NOT NULL DEFAULT 0 CHECK (start_half_day IN (0, 1)),
  end_half_day       INTEGER NOT NULL DEFAULT 0 CHECK (end_half_day IN (0, 1)),
  -- Working days as computed AT SUBMISSION from the applicable work week and
  -- holiday set, then frozen. Stored rather than recomputed on read so the
  -- number the employee was shown before submitting is the number that gets
  -- deducted — a tenant editing its holiday set in March must not silently
  -- change what somebody already had approved in January. REAL because half
  -- days make it fractional.
  working_days       REAL NOT NULL CHECK (working_days >= 0),
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
  -- cancellation raises a second approval, so it always names the live one; the
  -- full decision history lives in `approvals` itself, which is the audit record
  -- PRD-000 asks for.
  approval_id        TEXT,
  decided_at         TEXT,
  cancelled_at       TEXT,
  created_by         TEXT REFERENCES users(user_id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, leave_request_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, employee_id),
  CHECK (end_date >= start_date)
);

-- Carry 0025's rows across. `leave_type_code` is derived from the FK those rows
-- already carry; the LEFT JOIN keeps a row whose type was hard-deleted rather
-- than dropping it silently, and '' is a code no leave_types row can hold, so
-- such a row reads as unresolvable instead of masquerading as a real type.
INSERT INTO leave_requests_new (
  leave_request_id, tenant_id, employee_id, leave_type_code, leave_type_id,
  start_date, end_date, start_half_day, end_half_day, working_days,
  state, created_at, updated_at
)
SELECT
  r.leave_request_id,
  r.tenant_id,
  r.employee_id,
  COALESCE(t.code, ''),
  r.leave_type_id,
  r.start_date,
  r.end_date,
  r.start_half_day,
  r.end_half_day,
  r.working_days,
  r.state,
  r.created_at,
  r.updated_at
FROM leave_requests r
LEFT JOIN leave_types t
  ON t.tenant_id = r.tenant_id AND t.leave_type_id = r.leave_type_id;

DROP TABLE leave_requests;
ALTER TABLE leave_requests_new RENAME TO leave_requests;

-- S6's balance query: everything pending or approved for one person and one
-- leave type.
CREATE INDEX idx_leave_requests_balance
  ON leave_requests (tenant_id, employee_id, leave_type_id, state);
-- S7's balance query ("what has this employee taken and what is pending this
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
