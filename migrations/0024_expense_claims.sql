-- PRD-006a — expense claims and their GL posting.
--
-- The architecture-proving feature: a claim an employee photographs on their
-- phone becomes an approved journal entry with employee, project and department
-- dimensions, which then moves the cash position and the project's margin. No
-- standalone HR product can do that, because it does not own the books.
--
-- Three tables, and deliberately nothing else. Claims consume the PRD-000
-- primitives rather than re-implementing them:
--
--   * approval  -> `approvals`, subject_type = 'expense_claim' (already a value
--     in src/modules/approvals/types.ts — S3 reserved it, so this session adds
--     no enum value and no migration to that table, which is exactly the
--     zero-schema-additions guarantee PRD-000's success metric asks for).
--   * receipts  -> `files`, purpose = 'claim_receipt' (already in
--     src/modules/files/policy.ts).
--   * notifying -> the `approval.*` event consumer. No notification rows are
--     written by this module, and no claim.* type is mapped: the approver
--     already gets "approval needed" and the employee already gets
--     "approved"/"rejected". A second row per decision would double the badge.
--
-- ============================================================================
-- WHAT IS NOT HERE: THE SST INPUT LEG
-- ============================================================================
--
-- PRD-006's posting reads `Dr {category expense} / Dr SST Input (if applicable)
-- / Cr Employee Reimbursements Payable`. `SST Input` comes from PRD-001's tax
-- work, which is S12 and lands AFTER this session (SESSION-PLAN conflict C2).
--
-- So this session posts the TWO-leg entry and does not invent an SST account.
-- The "(if applicable)" in PRD-006 makes that legitimate: a tenant that is not
-- SST-registered never needs the leg, and unrecoverable input tax genuinely is
-- part of the expense. `expense_claim_lines.tax_cents` is captured anyway, so
-- S12 has the number it needs to add the third leg and reduce the expense debit
-- from gross to net. See src/modules/claims/posting.ts.
--
-- ============================================================================
-- WHY POSTINGS ARE source_type = 'manual'
-- ============================================================================
--
-- `journal_entries.source_type` carries `CHECK (source_type IN ('invoice',
-- 'payment', 'manual', 'reversal'))`. Adding 'claim' means altering that CHECK,
-- which SQLite can only do by rebuilding the table — and that rebuild is not
-- available here:
--
--   * `journal_lines` FK-references `journal_entries (tenant_id, entry_id)`, so
--     `DROP TABLE journal_entries` raises SQLITE_CONSTRAINT_FOREIGNKEY on any
--     database with rows in it.
--   * 0022_roles_drop_check.sql already proved D1 will not defer that FK —
--     `defer_foreign_keys`, `foreign_keys = off`, `legacy_alter_table` and
--     `writable_schema` were all tried and none work. Its fix was to empty the
--     referencing rows first.
--   * `journal_lines` cannot be emptied: `journal_lines_no_delete BEFORE DELETE
--     ... RAISE(ABORT)`. Getting past that means dropping the append-only
--     triggers mid-migration, which is the one thing every session is told not
--     to do.
--
-- So claim postings use 'manual' with `source_id = clm_...` and a memo naming
-- the claim. `source_id` carries a typed prefix, so "every claim posting" is
-- `WHERE source_id LIKE 'clm_%'` and "this claim's entry" is one indexed
-- lookup. The cost is cosmetic — the ledger view labels a system-generated
-- posting "manual". The right place to fix it is S12/S13, which touch finance
-- anyway and can spend one reviewed rebuild on the whole vocabulary
-- ('claim', 'claim_payment', 'credit_note') rather than smuggling a trigger
-- drop into this session.

-- ---------------------------------------------------------------------------
-- Claim categories — the mapping that makes posting possible.
-- ---------------------------------------------------------------------------
--
-- PRD-006: "Claim categories per tenant: mileage, meals, travel,
-- accommodation, supplies, other — each mapped to a GL expense account. This
-- mapping is what makes posting possible."
--
-- Per tenant and fully editable. The defaults are seeded by
-- src/modules/claims/categories.ts (INSERT OR IGNORE on the unique code), not
-- by this migration: seeding needs the tenant's own account ids, which are
-- per-tenant ULIDs created lazily by `ensureSystemAccounts`, so there is
-- nothing for a static migration to point at.
CREATE TABLE claim_categories (
  category_id        TEXT NOT NULL,             -- ccat_01J...
  tenant_id          TEXT NOT NULL REFERENCES tenants(tenant_id),
  -- Stable machine handle ('meals'), so seeding is idempotent and a tenant can
  -- rename the display label without breaking the seed's dedupe.
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  -- THE point of this table. A composite FK, so a category can never be mapped
  -- to another tenant's account. That the account is `type = 'expense'` and not
  -- archived is checked in the service — SQL cannot express it.
  expense_account_id TEXT NOT NULL,
  -- 'mileage' computes the amount from distance x rate instead of taking it
  -- from the filer. PRD-006 asks for mileage as a category rather than a
  -- separate feature, and this is the whole difference.
  kind               TEXT NOT NULL DEFAULT 'standard'
                       CHECK (kind IN ('standard', 'mileage')),
  -- Required when kind = 'mileage', NULL otherwise (enforced in the service).
  per_km_rate_cents  INTEGER,
  -- PRD-006: "Per-category limits with warning on breach." NULL = no limit.
  --
  -- Scope is PER CLAIM, per category: the sum of one claim's lines in this
  -- category. A calendar-window limit would need a period vocabulary and an
  -- answer to "which month does a backdated receipt count against", and
  -- PRD-006 asks only for a warning. A `limit_period` column is additive.
  limit_cents        INTEGER,
  archived_at        TEXT,                      -- soft delete; posted claims are untouched
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, category_id),
  -- Makes the default seed idempotent, per standing rule "cheap and repeatable".
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, expense_account_id) REFERENCES accounts(tenant_id, account_id)
);

-- ---------------------------------------------------------------------------
-- Claim headers.
-- ---------------------------------------------------------------------------
--
-- Lifecycle, in one place so it is auditable at a glance. Matches the 409
-- state-machine convention of src/modules/support/state-machine.ts, which
-- PRD-006's "approved claims are immutable" criterion needs:
--
--   draft     -> submitted | cancelled
--   submitted -> approved | rejected | draft (withdrawn)
--   rejected  -> submitted (resubmitted) | cancelled
--   approved  -> paid
--   paid      -> (terminal)
--   cancelled -> (terminal)
--
-- `rejected` is a RESTING, EDITABLE state rather than a terminal one. PRD-006:
-- "Rejection returns the claim to the employee with a comment; resubmission
-- allowed." Dropping it back to `draft` would satisfy that mechanically while
-- losing the reason it came back, which is the only thing the employee needs.
-- Resubmission creates a NEW `approvals` row and the rejected one stands — no
-- `supersedes` column anywhere (SESSION-PLAN conflict C8).
--
-- Editable only in `draft` and `rejected`. `approved` is a 409 because it has
-- hit the ledger; `submitted` is a 409 because an approver is looking at it
-- (withdraw it first).
CREATE TABLE expense_claims (
  claim_id          TEXT NOT NULL,              -- clm_01J...
  tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id),
  -- Whose expense it is. NOT NULL and an employee, not a user: the reporting
  -- line that resolves the approver runs between employees, and a claim can be
  -- filed on behalf of someone who has no console login at all.
  employee_id       TEXT NOT NULL,
  claim_date        TEXT NOT NULL,              -- ISO date YYYY-MM-DD
  description       TEXT,
  currency          TEXT NOT NULL CHECK (length(currency) = 3),
  -- Both maintained by the service as SUM over the lines, never written
  -- directly by a client. PRD-006's criterion is that the header total equals
  -- the sum of lines, so the header cannot be an independently settable field.
  total_cents       INTEGER NOT NULL DEFAULT 0,
  -- Recorded, NOT posted. See the SST note at the top of this file.
  tax_cents         INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'paid', 'cancelled')),
  -- Claim-level dimension defaults. A line may override either; the posting
  -- resolves line -> claim -> the employee's department (PRD-001a dimensions).
  project_id        TEXT,
  department_code   TEXT,                       -- src/departments/registry.ts id, validated in the service
  -- Who pressed submit, which is not always whose claim it is (an admin filing
  -- on behalf of someone). NULL until first submitted.
  submitted_by      TEXT REFERENCES users(user_id),
  submitted_at      TEXT,
  -- The live approval while `submitted`, the last one afterwards. Soft
  -- reference with no FK, the same choice `approval_nudges` makes: it keeps
  -- this table free of an ordering dependency on 0022, and the id is always
  -- validated by a tenant-scoped read before it is used.
  approval_id       TEXT,
  -- Why it came back. The one thing the employee actually needs on a rejection.
  rejection_comment TEXT,
  rejected_at       TEXT,
  -- The approval posting (Dr expense / Cr payable). NULL until approved, and
  -- written in the SAME D1 batch as the approval decision — that batch is
  -- PRD-006's atomicity criterion, "no approved claim without its entry".
  entry_id          TEXT,
  -- The reimbursement posting (Dr payable / Cr cash) and its reference.
  paid_entry_id     TEXT,
  payment_reference TEXT,
  paid_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, claim_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, employee_id)
);

-- "My claims, newest state first" — the employee self-service list.
CREATE INDEX idx_expense_claims_employee ON expense_claims (tenant_id, employee_id, status, claim_id);
-- "Approved but unpaid" — the reimbursement queue and the liability figure on
-- the dashboard's cash-flow outlook.
CREATE INDEX idx_expense_claims_status   ON expense_claims (tenant_id, status, claim_id);
-- Project attribution, mirroring the ledger's own dimension indexes (0020).
CREATE INDEX idx_expense_claims_project  ON expense_claims (tenant_id, project_id);

-- ---------------------------------------------------------------------------
-- Claim lines — one receipt each.
-- ---------------------------------------------------------------------------
--
-- PRD-006 wants multi-line claims: "one submission, several receipts". So the
-- receipt belongs to the LINE, not the header, and `receipt_file_id` is NOT
-- NULL. PRD-006's "a claim without a receipt is rejected" then falls out of
-- this constraint plus "a submitted claim needs at least one line" in the
-- service, rather than needing a rule of its own.
CREATE TABLE expense_claim_lines (
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  claim_id        TEXT NOT NULL,
  line_no         INTEGER NOT NULL,
  category_id     TEXT NOT NULL,
  description     TEXT,
  -- Mileage only: the distance claimed. REAL because 12.4 km is a normal claim.
  distance_km     REAL,
  -- Always the money, whether the filer typed it or mileage computed it from
  -- distance x rate. STORED rather than derived, so editing a category's
  -- per-km rate next year cannot retroactively change what was already posted.
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  -- Recorded, not posted (see the SST note). Part of `amount_cents`, not on
  -- top of it: the line amount is gross.
  tax_cents       INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  -- The receipt. A composite FK to `files`, so a claim can never point at
  -- another tenant's upload; that `purpose = 'claim_receipt'` is checked in the
  -- service, which is also where the per-purpose size and type policy lives.
  receipt_file_id TEXT NOT NULL,
  -- Line-level dimension overrides: one submission can span two projects.
  project_id      TEXT,
  department_code TEXT,
  PRIMARY KEY (tenant_id, claim_id, line_no),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES expense_claims(tenant_id, claim_id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES claim_categories(tenant_id, category_id),
  FOREIGN KEY (tenant_id, receipt_file_id) REFERENCES files(tenant_id, file_id)
);

-- Category rollups for the per-category limit check, which reads a single
-- claim's lines grouped by category.
CREATE INDEX idx_expense_claim_lines_category ON expense_claim_lines (tenant_id, category_id);
