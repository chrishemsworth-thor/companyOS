-- CompanyOS Phase 2 — People module (source_module: 'people'). The first HR
-- data domain: an employee directory with teams and reporting lines, flipping
-- the People department from `planned` to `live`.
--
-- Design decisions (see docs/modules/people.md):
--   * Departments stay a CODE registry (src/departments/registry.ts) — there is
--     still no departments table. `department_id` columns hold a registry id
--     string and are validated in the service, NOT by a CHECK, so the registry
--     can grow without a migration.
--   * Employees are HR records first; a console login is optional via a
--     nullable `user_id` link. `users` is keyed by user_id alone (0010), so a
--     tenant-composite FK is impossible — the service enforces the tenant match.
--   * Team membership is `employees.team_id` (one team per employee, like
--     deals.stage_id). A join table can be added additively if multi-team
--     membership is ever needed.
--   * `teams.lead_employee_id` and `employees.team_id` form a circular FK pair;
--     both are nullable so inserts never deadlock (create team with no lead →
--     create employees → patch the lead in).
--   * Reporting lines: `manager_employee_id` self-reference. The CHECK blocks
--     self-management; longer cycles can't be expressed in SQLite, so the
--     service walks the ancestor chain (recursive CTE) before every write.
--   * No hard deletes (system-wide convention) — offboarding is status='inactive'.

CREATE TABLE teams (
  team_id          TEXT NOT NULL,               -- team_01J...
  tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
  name             TEXT NOT NULL,
  description      TEXT,
  department_id    TEXT,                        -- registry id, e.g. 'technology'
  lead_employee_id TEXT,                        -- team lead (employee)
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, team_id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, lead_employee_id) REFERENCES employees(tenant_id, employee_id)
);
CREATE INDEX idx_teams_department ON teams (tenant_id, department_id);

CREATE TABLE employees (
  employee_id         TEXT NOT NULL,            -- emp_01J...
  tenant_id           TEXT NOT NULL REFERENCES tenants(tenant_id),
  name                TEXT NOT NULL,
  email               TEXT,                     -- work email; unique per tenant when present
  phone               TEXT,
  job_title           TEXT,
  department_id       TEXT NOT NULL,            -- registry id, validated in service
  team_id             TEXT,
  manager_employee_id TEXT CHECK (manager_employee_id IS NULL OR manager_employee_id <> employee_id),
  user_id             TEXT REFERENCES users(user_id),  -- optional console-login link
  employment_type     TEXT NOT NULL DEFAULT 'full_time'
    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'intern')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  start_date          TEXT,                     -- ISO date YYYY-MM-DD
  end_date            TEXT,
  location            TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams(tenant_id, team_id),
  FOREIGN KEY (tenant_id, manager_employee_id) REFERENCES employees(tenant_id, employee_id)
);
-- NULLs are distinct in SQLite unique indexes, so employees without an email
-- or login link don't collide.
CREATE UNIQUE INDEX idx_employees_email      ON employees (tenant_id, email);
CREATE UNIQUE INDEX idx_employees_user       ON employees (tenant_id, user_id);
CREATE INDEX idx_employees_department        ON employees (tenant_id, department_id);
CREATE INDEX idx_employees_team              ON employees (tenant_id, team_id);
CREATE INDEX idx_employees_manager           ON employees (tenant_id, manager_employee_id);
