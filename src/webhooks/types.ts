import type { IssuePriority, IssueStatus } from "../modules/build/types";

/** Inbound webhook ingestion domain types (see docs/modules/webhooks.md). */

export type WebhookProvider = "jira" | "github" | "bitbucket";

export const WEBHOOK_PROVIDERS: WebhookProvider[] = ["jira", "github", "bitbucket"];

export function isWebhookProvider(s: string): s is WebhookProvider {
  return (WEBHOOK_PROVIDERS as string[]).includes(s);
}

/** A connected external tracker/repo (webhook_sources row, migration 0014). */
export interface WebhookSource {
  source_id: string;
  tenant_id: string;
  provider: WebhookProvider;
  project_id: string;
  external_project_key: string | null;
  status: "active" | "disabled";
  created_at: string;
}

/**
 * What a raw provider delivery normalizes to. Normalizers are pure functions
 * of (headers, payload) so every provider quirk is unit-testable without HTTP.
 *
 * - issue_upsert: create-or-update a mirrored Build issue.
 * - code_event:   repo activity (push/PR) that becomes a log-only bus event.
 * - ping:         provider connectivity test; acknowledged, never ingested.
 * - ignored:      recognized but out of scope (e.g. PR closed without merge).
 */
export type NormalizedWebhookEvent =
  | {
      kind: "issue_upsert";
      external_id: string;
      title: string;
      description?: string;
      status: IssueStatus;
      priority: IssuePriority;
      assignee?: string;
      external_url?: string;
      /** JIRA project key or 'owner/repo' — matched against the source filter. */
      external_project?: string;
    }
  | {
      kind: "code_event";
      event_type: "code.push" | "code.pr_opened" | "code.pr_merged";
      payload: Record<string, unknown>;
      external_project?: string;
    }
  | { kind: "ping" }
  | { kind: "ignored"; reason: string };
