import type { IssueStatus } from "../../modules/build/types";
import type { NormalizedWebhookEvent } from "../types";

/**
 * GitHub webhook normalizer — pure function of (X-GitHub-Event, payload).
 * Handles ping, issues (→ issue_upsert), push and pull_request (→ code_event).
 *
 * GitHub issues are just open/closed; `state_reason` distinguishes
 * completed from not_planned on close. There is no priority — always medium.
 */

function mapIssueStatus(state: string | undefined, stateReason: string | null | undefined): IssueStatus {
  if (state === "open") return "todo";
  return stateReason === "not_planned" ? "cancelled" : "done";
}

export function normalizeGithub(
  githubEvent: string | undefined,
  payload: unknown,
): NormalizedWebhookEvent {
  if (!githubEvent) return { kind: "ignored", reason: "missing X-GitHub-Event header" };
  if (githubEvent === "ping") return { kind: "ping" };

  const body = payload as {
    action?: string;
    repository?: { full_name?: string };
    sender?: { login?: string };
    issue?: {
      number?: number;
      title?: string;
      body?: string | null;
      state?: string;
      state_reason?: string | null;
      html_url?: string;
      assignee?: { login?: string } | null;
    };
    ref?: string;
    commits?: unknown[];
    compare?: string;
    pull_request?: {
      number?: number;
      title?: string;
      merged?: boolean;
      html_url?: string;
      head?: { ref?: string };
      base?: { ref?: string };
    };
  };
  const repo = body?.repository?.full_name;

  if (githubEvent === "issues") {
    const issue = body.issue;
    if (!repo || issue?.number === undefined || !issue.title) {
      return { kind: "ignored", reason: "malformed GitHub issues payload" };
    }
    return {
      kind: "issue_upsert",
      external_id: `${repo}#${issue.number}`,
      title: issue.title,
      description: issue.body ?? undefined,
      status:
        body.action === "deleted" ? "cancelled" : mapIssueStatus(issue.state, issue.state_reason),
      priority: "medium",
      assignee: issue.assignee?.login ?? undefined,
      external_url: issue.html_url,
      external_project: repo,
    };
  }

  if (githubEvent === "push") {
    if (!repo) return { kind: "ignored", reason: "malformed GitHub push payload" };
    return {
      kind: "code_event",
      event_type: "code.push",
      payload: {
        provider: "github",
        repo,
        ...(body.ref ? { ref: body.ref } : {}),
        commit_count: Array.isArray(body.commits) ? body.commits.length : 0,
        ...(body.sender?.login ? { external_actor: body.sender.login } : {}),
        ...(body.compare ? { external_url: body.compare } : {}),
      },
      external_project: repo,
    };
  }

  if (githubEvent === "pull_request") {
    const pr = body.pull_request;
    if (!repo || pr?.number === undefined || !pr.title) {
      return { kind: "ignored", reason: "malformed GitHub pull_request payload" };
    }
    const eventType =
      body.action === "opened"
        ? "code.pr_opened"
        : body.action === "closed" && pr.merged
          ? "code.pr_merged"
          : null;
    if (!eventType) {
      return { kind: "ignored", reason: `unhandled pull_request action ${body.action}` };
    }
    return {
      kind: "code_event",
      event_type: eventType,
      payload: {
        provider: "github",
        repo,
        external_id: `${repo}#${pr.number}`,
        title: pr.title,
        ...(pr.head?.ref ? { source_branch: pr.head.ref } : {}),
        ...(pr.base?.ref ? { target_branch: pr.base.ref } : {}),
        ...(body.sender?.login ? { external_actor: body.sender.login } : {}),
        ...(pr.html_url ? { external_url: pr.html_url } : {}),
      },
      external_project: repo,
    };
  }

  return { kind: "ignored", reason: `unhandled GitHub event ${githubEvent}` };
}
