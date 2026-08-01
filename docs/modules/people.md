# People Module

Employee directory, teams, and reporting lines — the first HR data domain.
`source_module: people`. Flips the People department from `planned` to `live`.

**In scope:** employee records (HR-first, optional console-login link),
first-class teams, manager/reports-to hierarchy.
**Out of scope (for now):** payroll, manager-based authorization, multi-team
membership.

**Leave lives next door.** Leave policy, entitlement, public holidays and
balances are their own module on the same `source_module` and the same
capability gate — see [`leave.md`](leave.md), mounted at `/v1/people/leave`
with self-service at `/v1/me/leave`. It owns an employee's work state and work
week (`employee_leave_profiles`) rather than adding columns here. Leave
*requests* and the team calendar ship with PRD-006c.

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
- **Capability gate:** reads require `people:read` and writes `people:write`,
  enforced by the mount table in `src/index.ts` (PRD-008). That means
  `admin`/`operator`/`readonly` read the directory and `admin`/`operator` write
  it; `finance`, `support` and the self-service `employee` tier get a 403 —
  employment terms and HR notes are not general business data. System (API-key)
  callers bypass the matrix as everywhere. An employee reads *their own* record
  via `GET /v1/me/employee`.

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
| `POST /v1/people/employees/:id/invite` | `{role?}` (default `employee`, the least-privilege tier) | 201 `{employee, user, invite}` — or 200 `{employee, invite}` when re-sending |
| `GET /v1/people/teams` | — | `{teams: [...]}` |
| `POST /v1/people/teams` | `{name, description?, department_id?, lead_employee_id?}` | 201 team |
| `GET /v1/people/teams/:id` | — | team or 404 |
| `PATCH /v1/people/teams/:id` | any subset | updated team |

`?manager_id=` doubles as the direct-reports query the console's employee
detail page uses.

### Employees vs users (granting console access)

An **employee** is an HR record with no credentials; a **user** is a console
login. They are deliberately separate — not every employee needs platform
access, and the platform role can't be inferred from an HR record. Creating an
employee provisions no login and sends no email.

`employees.user_id` optionally links the two. `POST
/v1/people/employees/:id/invite` is the bridge: **admin only** (it mints a
login with a role, so it requires `admin:write` — the `/v1/users` bar — rather
than the router's `people:write`), it creates the user, sets `user_id` via
`updateEmployee` so `employee.updated` is emitted, and emails a single-use
invite through the shared `issueAndSendInvite` service (`src/auth/invites.ts`,
also used by `/v1/users`). Calling it again while the login is still pending
re-sends and invalidates the previous link.

Refusals: 422 `no_email` / `employee_inactive`; 409 `already_has_access` (the
linked login has a password), `user_disabled`, or `email_taken` (a login owns
that address but isn't linked — link it via `PATCH … {user_id}` instead, which
is a deliberate act rather than a guess that the two records are one person).

The role picked here decides real access: every `/v1` route enforces the
capability matrix in `src/auth/capabilities.ts` (PRD-008). It defaults to
`employee` — own records only — so an invite grants business access solely when
an admin chooses it. See
[`../architecture/roles-and-permissions.md`](../architecture/roles-and-permissions.md)
for what each role reaches.

Reporting lines feed approver resolution: `src/modules/approvals/resolver.ts`
climbs `manager_employee_id` to the first manager with an enabled login, which is
why linking `employees.user_id` matters beyond console access.

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

The employee detail page shows a **Platform access** field (admin only) and an
**Invite to platform** button — which becomes **Resend invite** while the
linked login is still pending, and disappears once the person has activated it
or when the employee has no email.
