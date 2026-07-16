import type { IssuePriority, IssueStatus } from "../../modules/build/types";
import type { NormalizedWebhookEvent } from "../types";

/**
 * JIRA Cloud webhook normalizer — pure function of the delivery payload.
 * Handles jira:issue_created / jira:issue_updated / jira:issue_deleted.
 *
 * Status mapping keys off statusCategory (the only stable field across
 * arbitrary per-team workflows): new→todo, indeterminate→in_progress,
 * done→done — unless the resolution looks like a cancellation, then
 * cancelled. A deleted issue is mirrored as cancelled (Build has no delete).
 */

const CANCELLED_RESOLUTION = /won't|wont|cancel|declin/i;

function mapStatus(statusCategoryKey: string | undefined, resolution: string | undefined): IssueStatus {
  switch (statusCategoryKey) {
    case "new":
      return "todo";
    case "indeterminate":
      return "in_progress";
    case "done":
      return resolution && CANCELLED_RESOLUTION.test(resolution) ? "cancelled" : "done";
    default:
      return "todo";
  }
}

function mapPriority(name: string | undefined): IssuePriority {
  switch (name?.toLowerCase()) {
    case "highest":
      return "urgent";
    case "high":
      return "high";
    case "low":
    case "lowest":
      return "low";
    default:
      return "medium";
  }
}

/**
 * JIRA Cloud v3 issue descriptions arrive as Atlassian Document Format (a
 * nested node tree). Flatten to plain text: concatenate text nodes, newline
 * between block-level nodes. Plain strings (v2 payloads) pass through as-is.
 */
export function adfToPlainText(description: unknown): string | undefined {
  if (description == null) return undefined;
  if (typeof description === "string") return description;
  if (typeof description !== "object") return undefined;

  const collect = (node: Record<string, unknown>): string => {
    if (typeof node.text === "string") return node.text;
    const content = node.content;
    if (!Array.isArray(content)) return "";
    const parts = content.map((child) =>
      child && typeof child === "object" ? collect(child as Record<string, unknown>) : "",
    );
    // Children of the root (and of nested containers) are block nodes —
    // separate them with newlines; inline text nodes concatenate naturally
    // because they have no `content` of their own.
    return parts.filter((p) => p !== "").join(node.type === "doc" ? "\n" : "");
  };

  const text = collect(description as Record<string, unknown>).trim();
  return text.length > 0 ? text : undefined;
}

export function normalizeJira(payload: unknown): NormalizedWebhookEvent {
  const body = payload as {
    webhookEvent?: string;
    issue?: {
      key?: string;
      self?: string;
      fields?: {
        summary?: string;
        description?: unknown;
        status?: { statusCategory?: { key?: string } };
        resolution?: { name?: string } | null;
        priority?: { name?: string } | null;
        assignee?: { displayName?: string } | null;
        project?: { key?: string };
      };
    };
  };

  const eventName = body?.webhookEvent;
  if (!eventName) return { kind: "ignored", reason: "missing webhookEvent" };
  if (!/^jira:issue_(created|updated|deleted)$/.test(eventName)) {
    return { kind: "ignored", reason: `unhandled JIRA event ${eventName}` };
  }

  const issue = body.issue;
  const fields = issue?.fields;
  if (!issue?.key || !fields?.summary) {
    return { kind: "ignored", reason: "malformed JIRA issue payload" };
  }

  // Browse URL from the REST self link's origin (self points at the API).
  let externalUrl: string | undefined;
  if (issue.self) {
    try {
      externalUrl = `${new URL(issue.self).origin}/browse/${issue.key}`;
    } catch {
      externalUrl = undefined;
    }
  }

  return {
    kind: "issue_upsert",
    external_id: issue.key,
    title: fields.summary,
    description: adfToPlainText(fields.description),
    status:
      eventName === "jira:issue_deleted"
        ? "cancelled"
        : mapStatus(fields.status?.statusCategory?.key, fields.resolution?.name),
    priority: mapPriority(fields.priority?.name ?? undefined),
    assignee: fields.assignee?.displayName,
    external_url: externalUrl,
    external_project: fields.project?.key,
  };
}
