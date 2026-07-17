-- Inbound webhook ingestion (JIRA Cloud / GitHub / Bitbucket Cloud → Build).
--
-- webhook_sources: one row per connected external tracker/repo. The source_id
-- doubles as the unguessable URL token (/webhooks/:provider/:source_id); the
-- per-source signing secret is DERIVED from WEBHOOK_MASTER_SECRET + source_id
-- at provisioning and verification time, so no secret material is stored here.
CREATE TABLE webhook_sources (
  source_id  TEXT PRIMARY KEY,              -- whs_<ulid>
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id),
  provider   TEXT NOT NULL CHECK (provider IN ('jira','github','bitbucket')),
  project_id TEXT NOT NULL,
  -- Optional delivery filter: JIRA project key ('PROJ') or 'owner/repo'.
  -- Deliveries for a different project/repo are acknowledged but ignored.
  external_project_key TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
);

CREATE INDEX idx_webhook_sources_tenant ON webhook_sources (tenant_id);

-- external_refs: maps a provider-native issue identity onto the Build issue
-- that mirrors it. This is the idempotent-upsert anchor — redeliveries and
-- out-of-order webhook events resolve to the same issue through this table.
-- external_id conventions: JIRA 'PROJ-123', GitHub 'owner/repo#42',
-- Bitbucket 'workspace/repo#7'.
CREATE TABLE external_refs (
  tenant_id    TEXT NOT NULL,
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  issue_id     TEXT NOT NULL,
  external_url TEXT,
  source_id    TEXT REFERENCES webhook_sources(source_id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, provider, external_id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES issues(tenant_id, issue_id)
);

CREATE INDEX idx_external_refs_issue ON external_refs (tenant_id, issue_id);

-- Mark mirrored issues so the UI and agents can tell native work from synced
-- work without joining external_refs.
ALTER TABLE issues ADD COLUMN origin TEXT NOT NULL DEFAULT 'native'
  CHECK (origin IN ('native','jira','github','bitbucket'));
