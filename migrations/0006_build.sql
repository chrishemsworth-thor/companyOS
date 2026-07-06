-- CompanyOS Phase 1 — native build module: projects and issues.
-- Deliberately minimal for agent consumers; assignee is free text (agent id
-- or a name) until a users table exists.

CREATE TABLE projects (
  project_id TEXT NOT NULL,                  -- prj_01J...
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id),
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE issues (
  issue_id    TEXT NOT NULL,                 -- iss_01J...
  tenant_id   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
  priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, issue_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
);
CREATE INDEX idx_issues_project ON issues (tenant_id, project_id, status);
