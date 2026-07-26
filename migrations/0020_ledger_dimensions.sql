-- PRD-001a — analytical dimensions on the journal line.
--
-- The ledger could already produce a P&L but not project profitability,
-- per-client margin, or department cost analysis, because a line carried only
-- account and amount. These five nullable columns turn every such rollup into a
-- SQL query rather than a new feature.
--
-- All columns are NULLABLE by design: every pre-existing entry stays valid and
-- no backfill is required. Untagged lines surface in an explicit "Unallocated"
-- bucket in the profitability rollup rather than being silently dropped.
--
-- Immutability comes for free. `journal_lines_no_update` (0002) already aborts
-- ANY update to the table, so a dimension cannot be edited after posting —
-- correcting a mis-tagged entry is a reversal plus a re-post, exactly as it is
-- for an amount. No new trigger is needed; test/ledger-dimensions.test.ts
-- asserts it.
--
-- These are plain TEXT with no foreign keys. SQLite cannot add a REFERENCES
-- constraint via ALTER TABLE, and `department_code` validates against the
-- in-code department registry (src/departments/registry.ts) rather than a table
-- — the same pattern as `employees.department_id`. Validation lives in the
-- ledger service.

ALTER TABLE journal_lines ADD COLUMN customer_id      TEXT;
ALTER TABLE journal_lines ADD COLUMN project_id       TEXT;
ALTER TABLE journal_lines ADD COLUMN department_code  TEXT;
ALTER TABLE journal_lines ADD COLUMN employee_id      TEXT;
-- Reserved free text: PRD-001 names it so a tenant with an existing cost-centre
-- vocabulary has somewhere to put it. Nothing reads it yet.
ALTER TABLE journal_lines ADD COLUMN cost_centre      TEXT;

-- The two rollup axes that need to be fast. Department grouping rides on the
-- 11-value registry, so a scan is fine; customer and project are unbounded.
CREATE INDEX idx_journal_lines_project  ON journal_lines (tenant_id, project_id);
CREATE INDEX idx_journal_lines_customer ON journal_lines (tenant_id, customer_id);

-- Revenue has to reach a project for project profitability to mean anything.
-- Nothing linked an invoice to a project before, so PRD-001's "project-linked
-- entries inherit project_id" had no derivation source on the revenue side —
-- only manual journal entries (and, later, PRD-006 expense claims) could tag
-- one. This nullable column is that link: an invoice raised against a project
-- stamps project_id onto both of its posting lines.
ALTER TABLE invoices ADD COLUMN project_id TEXT;
