import type { IssuePriority, IssueStatus } from "../../modules/build/types";
import type { NormalizedWebhookEvent } from "../types";

/**
 * Bitbucket Cloud webhook normalizer — pure function of (X-Event-Key, payload).
 * Handles issue:created / issue:updated (→ issue_upsert), repo:push and
 * pullrequest:created / pullrequest:fulfilled (→ code_event). Bitbucket's
 * issue tracker is rarely enabled; the code events are the main signal here.
 */

function mapIssueStatus(state: string | undefined): IssueStatus {
  switch (state) {
    case "new":
      return "todo";
    case "open":
    case "on hold":
      return "in_progress";
    case "resolved":
    case "closed":
      return "done";
    case "invalid":
    case "duplicate":
    case "wontfix":
      return "cancelled";
    default:
      return "todo";
  }
}

function mapPriority(priority: string | undefined): IssuePriority {
  switch (priority) {
    case "trivial":
    case "minor":
      return "low";
    case "critical":
      return "high";
    case "blocker":
      return "urgent";
    default:
      return "medium";
  }
}

export function normalizeBitbucket(
  eventKey: string | undefined,
  payload: unknown,
): NormalizedWebhookEvent {
  if (!eventKey) return { kind: "ignored", reason: "missing X-Event-Key header" };

  const body = payload as {
    repository?: { full_name?: string; links?: { html?: { href?: string } } };
    actor?: { display_name?: string };
    issue?: {
      id?: number;
      title?: string;
      content?: { raw?: string | null };
      state?: string;
      priority?: string;
      assignee?: { display_name?: string } | null;
      links?: { html?: { href?: string } };
    };
    push?: { changes?: unknown[] };
    pullrequest?: {
      id?: number;
      title?: string;
      source?: { branch?: { name?: string } };
      destination?: { branch?: { name?: string } };
      links?: { html?: { href?: string } };
    };
  };
  const repo = body?.repository?.full_name;

  if (eventKey === "issue:created" || eventKey === "issue:updated") {
    const issue = body.issue;
    if (!repo || issue?.id === undefined || !issue.title) {
      return { kind: "ignored", reason: "malformed Bitbucket issue payload" };
    }
    return {
      kind: "issue_upsert",
      external_id: `${repo}#${issue.id}`,
      title: issue.title,
      description: issue.content?.raw ?? undefined,
      status: mapIssueStatus(issue.state),
      priority: mapPriority(issue.priority),
      assignee: issue.assignee?.display_name,
      external_url: issue.links?.html?.href,
      external_project: repo,
    };
  }

  if (eventKey === "repo:push") {
    if (!repo) return { kind: "ignored", reason: "malformed Bitbucket push payload" };
    return {
      kind: "code_event",
      event_type: "code.push",
      payload: {
        provider: "bitbucket",
        repo,
        commit_count: Array.isArray(body.push?.changes) ? body.push.changes.length : 0,
        ...(body.actor?.display_name ? { external_actor: body.actor.display_name } : {}),
        ...(body.repository?.links?.html?.href
          ? { external_url: body.repository.links.html.href }
          : {}),
      },
      external_project: repo,
    };
  }

  if (eventKey === "pullrequest:created" || eventKey === "pullrequest:fulfilled") {
    const pr = body.pullrequest;
    if (!repo || pr?.id === undefined || !pr.title) {
      return { kind: "ignored", reason: "malformed Bitbucket pullrequest payload" };
    }
    return {
      kind: "code_event",
      event_type: eventKey === "pullrequest:created" ? "code.pr_opened" : "code.pr_merged",
      payload: {
        provider: "bitbucket",
        repo,
        external_id: `${repo}#${pr.id}`,
        title: pr.title,
        ...(pr.source?.branch?.name ? { source_branch: pr.source.branch.name } : {}),
        ...(pr.destination?.branch?.name ? { target_branch: pr.destination.branch.name } : {}),
        ...(body.actor?.display_name ? { external_actor: body.actor.display_name } : {}),
        ...(pr.links?.html?.href ? { external_url: pr.links.html.href } : {}),
      },
      external_project: repo,
    };
  }

  return { kind: "ignored", reason: `unhandled Bitbucket event ${eventKey}` };
}
