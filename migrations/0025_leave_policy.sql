-- PRD-006b (S6) — Leave: policy, entitlement, public holidays, balances.
--
-- Migration number: S5 (expense claims) is being built concurrently and takes
-- 0024; this session takes 0025. D1 applies migrations in filename order and
-- tolerates a gap, so this file applies cleanly whether or not 0024 has landed.
-- Nothing here ALTERs a table another session owns — `employees`, `accounts`,
-- `approvals` and `notifications` are all untouched, so the two branches cannot
-- collide in SQL.
--
-- Design decisions (see docs/modules/leave.md):
--
--   * PUBLIC HOLIDAYS ARE AN OVERLAY, NOT A COPY. The Malaysian holiday
--     calendar ships as a data file with the release
--     (src/modules/leave/holidays/data.ts) — the SESSION-PLAN blocking decision
--     for S6. This table therefore stores only the tenant's DELTAS against it:
--     a row with observed = 1 adds (or renames) a holiday, observed = 0
--     suppresses a shipped one. The effective set is resolved at read time.
--     Materialising the shipped rows per tenant instead would make the annual
--     update a backfill across every tenant, and would destroy the answer to
--     "did this tenant change it, or did we ship it that way?".
--
--   * LEAVE TYPES ARE ROWS, NOT AN ENUM. PRD-006 says the Malaysian defaults
--     are "all editable, none hardcoded". They are seeded per tenant, once
--     (leave_settings.defaults_seeded_at), and retired by archived_at rather
--     than deleted — the system-wide no-hard-delete convention, which also
--     stops a re-seed resurrecting a type the tenant retired.
--
--   * STATUTORY MINIMUMS ARE NOT IN THE SCHEMA. No CHECK encodes an Employment
--     Act 1955 floor. PRD-006 is explicit that the minimums are "a seed default
--     and a warning, not an enforced floor — a tenant may have contractual
--     terms above minimum and the system must not fight them". A CHECK would
--     also block terms BELOW minimum, which happens legitimately (probation
--     bands, non-EA contracts) and is HR's call, not the database's. The
--     warning is generated in src/modules/leave/statutory.ts and returned
--     alongside a successful save.
--
--   * CARRY-FORWARD IS ON THE POLICY, NOT THE TYPE. PRD-006 lists
--     "carry-forward rules" under leave_types; in practice the cap moves with
--     the entitlement, which is the policy's job. So the type carries
--     `carry_forward_allowed` (is this kind of leave carryable at all — annual
--     yes, sick no) and the policy carries the cap and the expiry window.
--
--   * WORK WEEK IS 7 FRACTIONS, NOT A BITMASK. 1 = full working day,
--     0.5 = half day, 0 = non-working, index 0 = Sunday. A bitmask cannot
--     express the Saturday half-day PRD-006 asks for, and Kelantan/Terengganu's
--     Sun-Thu week is just a different array.

-- ---------------------------------------------------------------------------
-- Tenant-level leave configuration. One row per tenant, created on first use.
-- ---------------------------------------------------------------------------
CREATE TABLE leave_settings (
  tenant_id          TEXT NOT NULL PRIMARY KEY REFERENCES tenants(tenant_id),
  -- JSON array of 7 day fractions, index 0 = Sunday. Default Mon-Fri.
  work_week          TEXT NOT NULL DEFAULT '[0,1,1,1,1,1,0]',
  -- Set once, by the Malaysian default seed. Its presence is what stops the
  -- seed re-running and resurrecting types the tenant has since archived.
  defaults_seeded_at TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Leave types — what kinds of leave this tenant offers.
-- ---------------------------------------------------------------------------
CREATE TABLE leave_types (
  leave_type_id         TEXT NOT NULL,             -- lvt_01J...
  tenant_id             TEXT NOT NULL REFERENCES tenants(tenant_id),
  code                  TEXT NOT NULL,             -- stable key: 'annual', 'sick', ...
  name                  TEXT NOT NULL,             -- editable label
  description           TEXT,
  is_paid               INTEGER NOT NULL DEFAULT 1,
  -- Medical certificates: S7 enforces this at submission.
  requires_attachment   INTEGER NOT NULL DEFAULT 0,
  max_consecutive_days  INTEGER,                   -- NULL = no cap
  allows_half_day       INTEGER NOT NULL DEFAULT 1,
  carry_forward_allowed INTEGER NOT NULL DEFAULT 0,
  -- Whether a request may take the balance below zero. Unpaid leave says yes;
  -- everything else says no, and S7 blocks with the shortfall stated.
  allow_negative_balance INTEGER NOT NULL DEFAULT 0,
  -- Which Employment Act 1955 minimum, if any, this type is measured against.
  -- NULL means no statutory floor exists (compassionate, unpaid) and no
  -- warning is ever produced. Keyed here rather than off `code` so a tenant
  -- renaming "Sick" to "Medical Leave" does not lose the warning.
  statutory_basis       TEXT CHECK (statutory_basis IS NULL OR statutory_basis IN
                          ('annual', 'sick', 'hospitalisation', 'maternity', 'paternity')),
  archived_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, leave_type_id),
  UNIQUE (tenant_id, code)
);

-- ---------------------------------------------------------------------------
-- Leave policies — how much leave, accrued how.
-- ---------------------------------------------------------------------------
CREATE TABLE leave_policies (
  policy_id                   TEXT NOT NULL,       -- lvp_01J...
  tenant_id                   TEXT NOT NULL REFERENCES tenants(tenant_id),
  leave_type_id               TEXT NOT NULL,
  name                        TEXT NOT NULL,
  accrual_method              TEXT NOT NULL DEFAULT 'annual_upfront'
    CHECK (accrual_method IN ('annual_upfront', 'monthly_accrual', 'on_anniversary')),
  -- Days that may roll into next year. 0 = none. Capped, never unbounded:
  -- PRD-006's criterion is "carry-forward capped at 5, 9 unused carries 5".
  carry_forward_max_days      REAL NOT NULL DEFAULT 0 CHECK (carry_forward_max_days >= 0),
  -- Months into the new leave year after which unused carried days lapse.
  -- NULL = they never lapse. 3 is the common Malaysian "use it by 31 March".
  carry_forward_expiry_months INTEGER CHECK (carry_forward_expiry_months IS NULL
                                             OR carry_forward_expiry_months BETWEEN 1 AND 12),
  -- The policy an employee falls to when HR has not assigned one explicitly.
  -- Without it, seeding defaults would be useless until somebody clicked
  -- through every employee.
  is_default                  INTEGER NOT NULL DEFAULT 0,
  archived_at                 TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, policy_id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, leave_type_id)
);
-- At most one live default per leave type. A partial unique index rather than
-- service-side bookkeeping, so two concurrent writes cannot both win.
CREATE UNIQUE INDEX idx_leave_policies_default ON leave_policies (tenant_id, leave_type_id)
  WHERE is_default = 1 AND archived_at IS NULL;
CREATE INDEX idx_leave_policies_type ON leave_policies (tenant_id, leave_type_id);

-- ---------------------------------------------------------------------------
-- Entitlement bands — days by employment type and tenure.
-- ---------------------------------------------------------------------------
CREATE TABLE leave_policy_bands (
  band_id            TEXT NOT NULL,                -- lvb_01J...
  tenant_id          TEXT NOT NULL REFERENCES tenants(tenant_id),
  policy_id          TEXT NOT NULL,
  -- NULL = applies to any employment type. A typed band wins over a NULL one,
  -- so "12 days for everyone, 8 for interns" is two rows, not four.
  employment_type    TEXT CHECK (employment_type IS NULL OR employment_type IN
                       ('full_time', 'part_time', 'contract', 'intern')),
  -- Tenure window in completed months of service: [min, max), max NULL = open.
  min_months_service INTEGER NOT NULL DEFAULT 0 CHECK (min_months_service >= 0),
  max_months_service INTEGER,
  entitlement_days   REAL NOT NULL CHECK (entitlement_days >= 0),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, band_id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES leave_policies(tenant_id, policy_id),
  CHECK (max_months_service IS NULL OR max_months_service > min_months_service)
);
CREATE INDEX idx_leave_policy_bands_policy ON leave_policy_bands (tenant_id, policy_id);

-- ---------------------------------------------------------------------------
-- Employee leave profile — the leave-side attributes of a person.
--
-- A separate table rather than columns on `employees` for two reasons: it keeps
-- leave concerns in the leave module, and it means S6 does not ALTER a table
-- the concurrent S5 branch also reads.
-- ---------------------------------------------------------------------------
CREATE TABLE employee_leave_profiles (
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  employee_id TEXT NOT NULL,
  -- Malaysian state / federal territory code (JHR, SGR, SWK, ...), validated in
  -- the service against src/modules/leave/holidays/states.ts. This is what
  -- decides whose Thaipusam and whose Gawai apply. NULL = national holidays
  -- only, which is the safe under-application: the employee sees one fewer
  -- holiday, never one they were not entitled to.
  work_state  TEXT,
  -- Per-employee work week override, same 7-fraction shape as the tenant
  -- default. NULL = inherit. This exists because one tenant can genuinely have
  -- both: a KL head office on Mon-Fri and a Kota Bharu branch on Sun-Thu.
  work_week   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, employee_id)
);

-- ---------------------------------------------------------------------------
-- Employee → policy assignment, per leave type.
-- ---------------------------------------------------------------------------
CREATE TABLE employee_leave_assignments (
  tenant_id                TEXT NOT NULL REFERENCES tenants(tenant_id),
  employee_id              TEXT NOT NULL,
  leave_type_id            TEXT NOT NULL,
  policy_id                TEXT NOT NULL,
  -- A flat override for this one person, bypassing the bands entirely — the
  -- "her contract says 21 days" case, which is exactly the contractual term
  -- above minimum the system must not fight.
  entitlement_days_override REAL CHECK (entitlement_days_override IS NULL
                                        OR entitlement_days_override >= 0),
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, employee_id, leave_type_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, employee_id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, leave_type_id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES leave_policies(tenant_id, policy_id)
);

-- ---------------------------------------------------------------------------
-- Public holidays — TENANT DELTAS ONLY. See the header note.
-- ---------------------------------------------------------------------------
CREATE TABLE public_holidays (
  holiday_id   TEXT NOT NULL,                      -- hol_01J...
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  holiday_date TEXT NOT NULL,                      -- ISO date YYYY-MM-DD
  name         TEXT NOT NULL,
  -- 'national' or a state/FT code. Deliberately no CHECK: the code list lives
  -- in src/modules/leave/holidays/states.ts and is validated in the service,
  -- the same choice 0015_people.sql makes for department ids.
  scope        TEXT NOT NULL,
  -- 1 = this is a holiday (an addition, or a rename of a shipped one).
  -- 0 = suppress the shipped holiday on this date and scope — the tenant that
  --     trades through Thaipusam, or replaces a holiday with a substitute day.
  observed     INTEGER NOT NULL DEFAULT 1 CHECK (observed IN (0, 1)),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, holiday_id),
  -- One ruling per date per scope, so "is this day off?" has a single answer.
  UNIQUE (tenant_id, holiday_date, scope)
);
CREATE INDEX idx_public_holidays_date ON public_holidays (tenant_id, holiday_date);

-- ---------------------------------------------------------------------------
-- Balance adjustments — carry-forward grants and manual corrections.
--
-- Balances themselves are DERIVED, never stored: entitlement + carry-forward
-- + adjustments - taken - pending, computed on read. The only things that must
-- persist are the ones that cannot be recomputed later, and carry-forward is
-- exactly that — it depends on the cap as it stood at year-close.
-- ---------------------------------------------------------------------------
CREATE TABLE leave_balance_adjustments (
  adjustment_id TEXT NOT NULL,                     -- lva_01J...
  tenant_id     TEXT NOT NULL REFERENCES tenants(tenant_id),
  employee_id   TEXT NOT NULL,
  leave_type_id TEXT NOT NULL,
  -- The leave year the days land IN. A 2025 year-close writes a row for 2026.
  leave_year    INTEGER NOT NULL,
  days          REAL NOT NULL,                     -- may be negative (a correction)
  kind          TEXT NOT NULL CHECK (kind IN ('carry_forward', 'adjustment', 'encashment')),
  note          TEXT,
  created_by    TEXT REFERENCES users(user_id),    -- NULL for a system year-close
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, adjustment_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, employee_id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, leave_type_id)
);
-- Year-close idempotency, enforced in SQL rather than by a service check:
-- running the close twice must not double anyone's carried days. Manual
-- adjustments are unconstrained — you can make several.
CREATE UNIQUE INDEX idx_leave_carry_forward_once
  ON leave_balance_adjustments (tenant_id, employee_id, leave_type_id, leave_year)
  WHERE kind = 'carry_forward';
CREATE INDEX idx_leave_adjustments_lookup
  ON leave_balance_adjustments (tenant_id, employee_id, leave_type_id, leave_year);

-- ---------------------------------------------------------------------------
-- Leave requests — created HERE, written by S7.
--
-- S6 owns no request write path: no routes, no events, no state machine. The
-- table exists in this migration because two of S6's own acceptance criteria
-- are about it — "a pending request reduces available balance immediately" and
-- "a rejected request restores it" — and a balance defined as
-- entitlement - taken - pending cannot be built or tested without the thing
-- being consumed.
--
-- So these are the balance-relevant columns ONLY. S7 (PRD-006c) adds `reason`,
-- `attachment_file_id`, the approval linkage and the leave.* events additively,
-- and owns the state machine. S6's tests insert rows directly through env.DB.
-- ---------------------------------------------------------------------------
CREATE TABLE leave_requests (
  leave_request_id TEXT NOT NULL,                  -- lvr_01J...
  tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
  employee_id      TEXT NOT NULL,
  leave_type_id    TEXT NOT NULL,
  start_date       TEXT NOT NULL,                  -- ISO date, inclusive
  end_date         TEXT NOT NULL,                  -- ISO date, inclusive
  -- Half-day markers on the boundary days only: a leave run is whole days in
  -- the middle by definition. Both may be set on a single-day request, which
  -- is how a 0.5-day request is expressed.
  start_half_day   INTEGER NOT NULL DEFAULT 0 CHECK (start_half_day IN (0, 1)),
  end_half_day     INTEGER NOT NULL DEFAULT 0 CHECK (end_half_day IN (0, 1)),
  -- Working days as computed AT SUBMISSION, against the work week and holiday
  -- set in force then. Stored rather than recomputed so that a later holiday
  -- correction cannot silently restate a request somebody already approved.
  working_days     REAL NOT NULL CHECK (working_days >= 0),
  state            TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, leave_request_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, employee_id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, leave_type_id),
  CHECK (end_date >= start_date)
);
-- The balance query's index: everything pending or approved for one person and
-- one leave type.
CREATE INDEX idx_leave_requests_balance
  ON leave_requests (tenant_id, employee_id, leave_type_id, state);
-- S7's team calendar reads by date range.
CREATE INDEX idx_leave_requests_dates ON leave_requests (tenant_id, start_date, end_date);
