-- CompanyOS Phase 1 — native finance module: double-entry ledger.
-- The ledger is append-only: journal entries and lines can never be updated or
-- deleted (enforced by triggers below). Corrections are reversal entries.
-- Money is INTEGER cents; lines use a signed convention: > 0 debit, < 0 credit,
-- and every entry's lines must sum to exactly 0 (enforced in the service layer,
-- posted atomically via D1 batch).

-- Chart of accounts. System accounts are seeded per tenant on first use.
CREATE TABLE accounts (
  account_id  TEXT NOT NULL,                 -- acct_01J...
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  code        TEXT NOT NULL,                 -- e.g. '1100'
  name        TEXT NOT NULL,                 -- e.g. 'Accounts Receivable'
  type        TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  is_system   INTEGER NOT NULL DEFAULT 0,    -- system accounts cannot be archived
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, account_id),
  UNIQUE (tenant_id, code)
);

-- Journal entry headers.
CREATE TABLE journal_entries (
  entry_id    TEXT NOT NULL,                 -- je_01J... (ULID, time-sortable)
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  entry_date  TEXT NOT NULL,                 -- ISO date
  memo        TEXT,
  currency    TEXT NOT NULL CHECK (length(currency) = 3),
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice', 'payment', 'manual', 'reversal')),
  source_id   TEXT,                          -- inv_... / pay_... backlink
  reverses_entry_id TEXT,                    -- set only when source_type = 'reversal'
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, entry_id)
);

-- Journal lines: one debit or credit per row.
CREATE TABLE journal_lines (
  entry_id    TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  line_no     INTEGER NOT NULL,
  account_id  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
  PRIMARY KEY (tenant_id, entry_id, line_no),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entries(tenant_id, entry_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, account_id)
);
CREATE INDEX idx_journal_lines_account ON journal_lines (tenant_id, account_id);

-- Immutability: corrections are reversal entries, never edits.
CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries
  BEGIN SELECT RAISE(ABORT, 'journal_entries is append-only'); END;
CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries
  BEGIN SELECT RAISE(ABORT, 'journal_entries is append-only'); END;
CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines
  BEGIN SELECT RAISE(ABORT, 'journal_lines is append-only'); END;
CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines
  BEGIN SELECT RAISE(ABORT, 'journal_lines is append-only'); END;

-- Invoice lifecycle columns. The invoice header is mutable state (status,
-- timestamps); the ledger behind it is not.
ALTER TABLE invoices ADD COLUMN total_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN issued_at TEXT;
ALTER TABLE invoices ADD COLUMN sent_at TEXT;
ALTER TABLE invoices ADD COLUMN paid_at TEXT;
CREATE INDEX idx_invoices_due ON invoices (tenant_id, status, due_date);

CREATE TABLE invoice_lines (
  invoice_id  TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  line_no     INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_cents  INTEGER NOT NULL CHECK (unit_cents >= 0),
  PRIMARY KEY (tenant_id, invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, invoice_id)
);

CREATE TABLE payments (
  payment_id  TEXT NOT NULL,                 -- pay_01J...
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  customer_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency    TEXT NOT NULL CHECK (length(currency) = 3),
  method      TEXT NOT NULL DEFAULT 'bank_transfer',
  received_at TEXT NOT NULL,
  entry_id    TEXT,                          -- backlink to the journal entry it posted
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, payment_id)
);

-- A payment can settle several invoices; an invoice can be settled by several payments.
CREATE TABLE payment_applications (
  payment_id  TEXT NOT NULL,
  invoice_id  TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  applied_cents INTEGER NOT NULL CHECK (applied_cents > 0),
  PRIMARY KEY (tenant_id, payment_id, invoice_id)
);
