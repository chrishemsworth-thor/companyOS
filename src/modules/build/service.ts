import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { paginate } from "../../gateway/pagination";
import type { Issue, IssueOrigin, IssuePriority, IssueStatus, Project } from "./types";

/**
 * Native build service. Issues have no formal transition table — unlike
 * tickets, project work legitimately jumps around the board — but 'done' and
 * 'cancelled' are settled states that can only move back to 'todo' (re-open).
 */

export class BuildError extends Error {
  constructor(
    readonly code: "not_found" | "illegal_transition",
    message: string,
    readonly httpStatus: 404 | 409 = 409,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

export async function getProject(
  db: D1Database,
  tenantId: string,
  projectId: string,
): Promise<Project | null> {
  return db
    .prepare(
      "SELECT project_id, name, status, created_at FROM projects WHERE tenant_id = ? AND project_id = ?",
    )
    .bind(tenantId, projectId)
    .first<Project>();
}

export async function listProjects(
  db: D1Database,
  tenantId: string,
  page: { cursor?: string; limit: number },
): Promise<{ projects: Project[]; next_cursor: string | null }> {
  const clauses = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (page.cursor) {
    clauses.push("project_id > ?");
    binds.push(page.cursor);
  }
  binds.push(page.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT project_id, name, status, created_at FROM projects WHERE ${clauses.join(" AND ")}
       ORDER BY project_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<Project>();
  const { items, next_cursor } = paginate(results, page.limit, "project_id");
  return { projects: items, next_cursor };
}

export async function createProject(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: { name: string },
): Promise<Project> {
  const projectId = `prj_${ulid()}`;
  await env.DB.prepare("INSERT INTO projects (project_id, tenant_id, name) VALUES (?, ?, ?)")
    .bind(projectId, tenantId, input.name)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "project.created",
      source_module: "build",
      tenant_id: tenantId,
      payload: { project_id: projectId, name: input.name },
    }),
  );

  return (await getProject(env.DB, tenantId, projectId))!;
}

const ISSUE_COLUMNS =
  "issue_id, project_id, title, description, status, priority, assignee, origin, created_at, updated_at";

export async function getIssue(
  db: D1Database,
  tenantId: string,
  issueId: string,
): Promise<Issue | null> {
  return db
    .prepare(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE tenant_id = ? AND issue_id = ?`)
    .bind(tenantId, issueId)
    .first<Issue>();
}

export async function listIssues(
  db: D1Database,
  tenantId: string,
  filter: { project_id?: string; status?: IssueStatus; cursor?: string; limit: number },
): Promise<{ issues: Issue[]; next_cursor: string | null }> {
  const clauses = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (filter.project_id) {
    clauses.push("project_id = ?");
    binds.push(filter.project_id);
  }
  if (filter.status) {
    clauses.push("status = ?");
    binds.push(filter.status);
  }
  if (filter.cursor) {
    clauses.push("issue_id > ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT ${ISSUE_COLUMNS} FROM issues WHERE ${clauses.join(" AND ")}
       ORDER BY issue_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<Issue>();
  const { items, next_cursor } = paginate(results, filter.limit, "issue_id");
  return { issues: items, next_cursor };
}

export async function createIssue(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: {
    project_id: string;
    title: string;
    description?: string;
    priority?: IssuePriority;
    assignee?: string;
    /** Set by webhook ingestion for issues mirrored from an external tracker. */
    origin?: IssueOrigin;
    external?: { provider: "jira" | "github" | "bitbucket"; external_id: string; external_url?: string };
  },
): Promise<Issue> {
  const project = await getProject(env.DB, tenantId, input.project_id);
  if (!project) throw new BuildError("not_found", `project ${input.project_id} not found`, 404);

  const issueId = `iss_${ulid()}`;
  const priority = input.priority ?? "medium";
  await env.DB.prepare(
    `INSERT INTO issues (issue_id, tenant_id, project_id, title, description, priority, assignee, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      issueId,
      tenantId,
      input.project_id,
      input.title,
      input.description ?? null,
      priority,
      input.assignee ?? null,
      input.origin ?? "native",
    )
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "issue.created",
      source_module: "build",
      tenant_id: tenantId,
      payload: {
        issue_id: issueId,
        project_id: input.project_id,
        title: input.title,
        priority,
        ...(input.external
          ? {
              provider: input.external.provider,
              external_id: input.external.external_id,
              ...(input.external.external_url ? { external_url: input.external.external_url } : {}),
            }
          : {}),
      },
    }),
  );

  return (await getIssue(env.DB, tenantId, issueId))!;
}

/**
 * Patch mutable issue fields (title/description/priority/assignee) without
 * touching status. Used by webhook ingestion to keep mirrored issues in step
 * with their external source; emits no event in phase 1 (there is no
 * issue.updated type yet).
 */
export async function updateIssueDetails(
  db: D1Database,
  tenantId: string,
  issueId: string,
  patch: {
    title?: string;
    description?: string | null;
    priority?: IssuePriority;
    assignee?: string | null;
  },
): Promise<Issue> {
  const issue = await getIssue(db, tenantId, issueId);
  if (!issue) throw new BuildError("not_found", "issue not found", 404);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    binds.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    binds.push(patch.description);
  }
  if (patch.priority !== undefined) {
    sets.push("priority = ?");
    binds.push(patch.priority);
  }
  if (patch.assignee !== undefined) {
    sets.push("assignee = ?");
    binds.push(patch.assignee);
  }
  if (sets.length === 0) return issue;

  sets.push("updated_at = ?");
  binds.push(new Date().toISOString(), tenantId, issueId);
  await db
    .prepare(`UPDATE issues SET ${sets.join(", ")} WHERE tenant_id = ? AND issue_id = ?`)
    .bind(...binds)
    .run();

  return (await getIssue(db, tenantId, issueId))!;
}

const SETTLED: IssueStatus[] = ["done", "cancelled"];

export async function changeIssueStatus(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  issueId: string,
  to: IssueStatus,
): Promise<Issue> {
  const issue = await getIssue(env.DB, tenantId, issueId);
  if (!issue) throw new BuildError("not_found", "issue not found", 404);
  if (issue.status === to) return issue;
  if (SETTLED.includes(issue.status) && to !== "todo") {
    throw new BuildError(
      "illegal_transition",
      `${issue.status} issues can only be re-opened to todo`,
    );
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE issues SET status = ?, updated_at = ? WHERE tenant_id = ? AND issue_id = ?",
  )
    .bind(to, now, tenantId, issueId)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "issue.status_changed",
      source_module: "build",
      tenant_id: tenantId,
      payload: { issue_id: issueId, project_id: issue.project_id, from: issue.status, to },
    }),
  );
  if (to === "done") {
    await env.EVENTS.send(
      makeEnvelope({
        event_type: "issue.completed",
        source_module: "build",
        tenant_id: tenantId,
        payload: { issue_id: issueId, project_id: issue.project_id, completed_at: now },
      }),
    );
  }

  return (await getIssue(env.DB, tenantId, issueId))!;
}
