# People Module

Employee directory, teams, and reporting lines — the first HR data domain.
`source_module: people`. Flips the People department from `planned` to `live`.

**In scope:** employee records (HR-first, optional console-login link),
first-class teams, manager/reports-to hierarchy.
**Out of scope (for now):** leave and approval workflows, payroll,
manager-based authorization, multi-team membership.

## Data model (`migrations/0015_people.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `teams` | Per-tenant team | `team_id` (`team_`), `name` (unique per tenant), `description`, `department_id` (registry id), `lead_employee_id` (FK employees) |
| `employees` | HR record | `employee_id` (`emp_`), `name`, `email` (unique per tenant when present), `job_title`, `department_id` (registry id, required), `team_id` (FK), `manager_employee_id` (self-FK), `user_id` (FK users, unique per tenant), `employment_type` (`full_time\|part_time\|contract\|intern`), `status` (`active\|inactive`), `start_date`, `end_date`, `location`, `notes` |

## Business rules

- **Departments stay a code registry.** `department_id` is a registry id
  string (`src/departments/registry.ts`), validated in the service — there is
  still no departments table, and the lens rule from
  `docs/architecture/department-lens.md` is unchanged. Planned departments are
  allowed (an employee can sit in Legal before that module ships).
- **Employees are HR records first.** The `users` row is auth identity; an
  employee optionally links to one via `user_id` (same tenant enforced in the
  service — the `users` PK is global so a composite FK is impossible; one
  employee per login via a unique index).
- **Single-team membership:** `employees.team_id`, like `deals.stage_id`. A
  join table can be added additively if multi-team is ever needed.
- **Reporting lines:** `manager_employee_id` self-reference. Self-management
  is blocked by a table CHECK; longer cycles are rejected in the service by a
  recursive-CTE walk up the proposed manager's ancestor chain (SQLite can't
  express this as a constraint). Hierarchy is stored, not authorized on — a
  manager gets no extra access in v1.
- **No hard deletes:** offboarding is `status = 'inactive'`.
- **Write gate:** People mutations require role `admin` or `operator` — the
  first business-route use of `requireRole()`. Reads stay open to any
  authenticated caller; system (API-key) callers bypass the gate as everywhere.

## API

Auth as everywhere. `PeopleError` maps to 404 (`not_found`), 409
(`email_taken`, `name_taken`, `user_already_linked`), and 422
(`invalid_department`, `invalid_team`, `invalid_manager`, `manager_cycle`,
`user_not_found`).

| Method & path | Body | Returns |
|---|---|---|
| `GET /v1/people/employees?department_id=&team_id=&manager_id=&status=&limit=&cursor=` | — | `{employees: [...], next_cursor}` |
| `POST /v1/people/employees` | `{name, department_id, email?, phone?, job_title?, team_id?, manager_employee_id?, user_id?, employment_type?, status?, start_date?, end_date?, location?, notes?}` | 201 employee |
| `GET /v1/people/employees/:id` | — | employee or 404 |
| `PATCH /v1/people/employees/:id` | any subset (nullable fields clear with `null`) | updated employee |
| `GET /v1/people/teams` | — | `{teams: [...]}` |
| `POST /v1/people/teams` | `{name, description?, department_id?, lead_employee_id?}` | 201 team |
| `GET /v1/people/teams/:id` | — | team or 404 |
| `PATCH /v1/people/teams/:id` | any subset | updated team |

`?manager_id=` doubles as the direct-reports query the console's employee
detail page uses.

## Events emitted

| Event | Version | Payload | When |
|---|---|---|---|
| `employee.created` | v1 | `{employee_id, name, department_id, email?, team_id?, manager_employee_id?}` | employee created |
| `employee.updated` | v1 | `{employee_id, changed: [fields]}` | employee patched |
| `team.created` | v1 | `{team_id, name, department_id?}` | team created |

## Console

People department (live) exposes **Employees** (`/employees` directory with
department/status filters; `/employees/:id` detail with profile, manager link,
and direct reports) and **Teams** (`/teams` list with lead + member count).
