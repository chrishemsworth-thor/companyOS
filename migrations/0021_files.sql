-- PRD-000a — the file storage primitive.
--
-- Three planned features (quote logos, expense-claim receipts, signature
-- images) each need to store a binary and hand back a stable reference. This
-- is that reference: one tenant-scoped row per uploaded object, with the bytes
-- themselves in R2 under `{tenant_id}/{uuid}`.
--
-- Ownership lives HERE, not in the key. The key prefix is a layout
-- convention that makes a tenant's objects greppable; the read path resolves
-- this row and compares `tenant_id` to the caller before streaming. A caller
-- who guesses a key gets nothing, and a cross-tenant read by file id returns
-- 404 rather than 403 so the response never confirms the id exists.
--
-- `purpose` is plain TEXT validated by a Zod enum in the service
-- (src/modules/files/policy.ts), deliberately NOT a SQL CHECK. Per-purpose
-- policy — max bytes, allowed content types, public readability — is the whole
-- point of the column (see SESSION-PLAN conflict C3), and consuming PRDs add
-- purposes as they land: PRD-005 wants public customer uploads with stricter
-- limits than the authenticated path. A CHECK would force a migration per
-- consuming module. The codebase does use CHECK elsewhere (e.g.
-- `employees.employment_type`), so this is a considered divergence, the same
-- one the approvals primitive makes for `subject_type`.
--
-- Uploads are immutable: there is no versioning and no update path. A replaced
-- logo is a new row and a new object.

CREATE TABLE files (
  file_id      TEXT NOT NULL,                 -- file_01J...
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  r2_key       TEXT NOT NULL,                 -- {tenant_id}/{uuid}
  filename     TEXT NOT NULL,                 -- as supplied by the uploader
  content_type TEXT NOT NULL,                 -- validated against the purpose policy
  size_bytes   INTEGER NOT NULL,              -- actual stored length, not the declared one
  -- SHA-256 hex of the content. PRD-004 needs it to prove a signature image
  -- was not swapped after the fact; it also doubles as the read path's ETag.
  sha256       TEXT NOT NULL,
  purpose      TEXT NOT NULL,                 -- quote_logo | claim_receipt | signature | other
  uploaded_by  TEXT,                          -- usr_...; NULL for tenant-API-key (system) callers
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Soft delete. The row survives for the audit trail ("who uploaded what, and
  -- when was it removed"); the R2 object is hard-deleted in the same call, so
  -- the bytes are genuinely gone while the record of them is not.
  deleted_at   TEXT,
  PRIMARY KEY (tenant_id, file_id)
);

-- "Every logo for this tenant, newest first" — the shape S9 will want.
CREATE INDEX idx_files_purpose ON files (tenant_id, purpose, created_at);
-- One row per object. A UUID collision would otherwise silently orphan bytes.
CREATE UNIQUE INDEX idx_files_r2_key ON files (r2_key);
