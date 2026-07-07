# Build Module

Native projects and issues. Replaces Plane. `source_module: build`.

**In scope:** projects, issues with statuses/priorities/free-text assignee.
**Out of scope (for now):** cycles/sprints, a users table (assignee is a free
string — an agent id or a name), comments, attachments, dependencies.

## Data model (`migrations/0006_build.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `projects` | Container | `project_id` (`prj_`), `name`, `status` (`active\|archived`) |
| `issues` | Work items | `issue_id` (`iss_`), `project_id` (FK), `title`, `description?`, `status` (`todo\|in_progress\|done\|cancelled`), `priority` (`low\|medium\|high\|urgent`), `assignee?` |

## Business rules

Unlike tickets, issues have **no formal transition table** — project work
legitimately jumps around the board. The one rule: `done` and `cancelled` are
settled states that can only move back to `todo` (re-open); anything else is a
409. Reaching `done` emits `issue.completed` alongside `issue.status_changed`.

Build events are the first with **no `customer_id`** — they exercise the queue
consumer's log-only path: the per-event-type routing map (`AGENT_ROUTES` in
`src/queue/consumer.ts`) has no entry for them, so they are validated,
appended to `events_log`, and acked without touching any agent DO.

## API

Auth as everywhere. `BuildError` maps to 404 (`not_found`) and 409
(`illegal_transition`).

| Method & path | Body | Returns |
|---|---|---|
| `GET /v1/projects?limit=&cursor=` | — | `{projects: [...], next_cursor}` |
| `POST /v1/projects` | `{name}` | 201 project (`active`) |
| `GET /v1/projects/:id` | — | project or 404 |
| `GET /v1/issues?project_id=&status=&limit=&cursor=` | — | `{issues: [...], next_cursor}` (filters optional, combinable) |
| `POST /v1/issues` | `{project_id, title, description?, priority?, assignee?}` | 201 issue (`todo`); unknown project → 404 |
| `GET /v1/issues/:id` | — | issue or 404 |
| `POST /v1/issues/:id/status` | `{status}` | issue; settled→non-todo → 409; no-op moves return the issue unchanged |

## Events emitted

| Event | Version | Payload | When |
|---|---|---|---|
| `project.created` | v1 | `project_id, name` | `createProject` |
| `issue.created` | v1 | `issue_id, project_id, title, priority` | `createIssue` |
| `issue.status_changed` | v1 | `issue_id, project_id, from, to` | `changeIssueStatus` |
| `issue.completed` | v1 | `issue_id, project_id, completed_at` | transition to `done` |

## Service layer (`src/modules/build/service.ts`)

`createProject`, `getProject`, `listProjects`, `createIssue`, `getIssue`,
`listIssues` (composable filters), `changeIssueStatus`. Throws `BuildError`.

## Tests

`test/build.test.ts` — project/issue CRUD, unknown-project rejection,
project+status filtering, the settled-status re-open rule, and an
`issue.completed` envelope fed through the queue consumer proving the
log-only path (acked + in `events_log`, no agent routing, no retry).
