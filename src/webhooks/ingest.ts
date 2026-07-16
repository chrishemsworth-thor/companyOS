import type { Env } from "../env";
import {
  BuildError,
  changeIssueStatus,
  createIssue,
  getIssue,
  updateIssueDetails,
} from "../modules/build/service";
import type { IssueStatus } from "../modules/build/types";
import { makeEnvelope } from "../schemas/envelope";
import { emitEvent } from "../queue/producer";
import type { NormalizedWebhookEvent, WebhookSource } from "./types";

export type IngestResult =
  | { status: "processed"; issue_id?: string }
  | { status: "ignored"; reason: string };

/**
 * Move a mirrored issue to the externally-observed status through the normal
 * service (never direct writes, so invariants hold and events flow). External
 * trackers can legally jump a settled issue anywhere (JIRA reopens done →
 * in_progress); Build only allows settled → todo, so on illegal_transition we
 * reopen to todo first and then move on — two honest status_changed events.
 */
async function alignStatus(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  issueId: string,
  target: IssueStatus,
): Promise<void> {
  try {
    await changeIssueStatus(env, tenantId, issueId, target);
  } catch (err) {
    if (err instanceof BuildError && err.code === "illegal_transition") {
      await changeIssueStatus(env, tenantId, issueId, "todo");
      await changeIssueStatus(env, tenantId, issueId, target);
      return;
    }
    throw err;
  }
}

/** Apply a normalized webhook event to the source's tenant. */
export async function ingestNormalizedEvent(
  env: Env,
  source: WebhookSource,
  event: NormalizedWebhookEvent,
): Promise<IngestResult> {
  if (event.kind === "ping") return { status: "processed" };
  if (event.kind === "ignored") return { status: "ignored", reason: event.reason };

  // Per-source delivery filter: a workspace-wide JIRA hook or org-wide GitHub
  // app can deliver for projects/repos this source doesn't mirror.
  if (
    source.external_project_key &&
    event.external_project &&
    event.external_project !== source.external_project_key
  ) {
    return {
      status: "ignored",
      reason: `delivery for ${event.external_project}, source is filtered to ${source.external_project_key}`,
    };
  }

  if (event.kind === "code_event") {
    await emitEvent(
      env,
      makeEnvelope({
        event_type: event.event_type,
        source_module: "build",
        tenant_id: source.tenant_id,
        payload: event.payload,
      }),
    );
    return { status: "processed" };
  }

  // issue_upsert — external_refs is the idempotent anchor.
  const ref = await env.DB.prepare(
    "SELECT issue_id FROM external_refs WHERE tenant_id = ? AND provider = ? AND external_id = ?",
  )
    .bind(source.tenant_id, source.provider, event.external_id)
    .first<{ issue_id: string }>();

  let issueId: string;
  if (ref) {
    issueId = ref.issue_id;
    await updateIssueDetails(env.DB, source.tenant_id, issueId, {
      title: event.title,
      description: event.description ?? null,
      priority: event.priority,
      assignee: event.assignee ?? null,
    });
    await env.DB.prepare(
      `UPDATE external_refs SET external_url = ?, updated_at = ?
       WHERE tenant_id = ? AND provider = ? AND external_id = ?`,
    )
      .bind(
        event.external_url ?? null,
        new Date().toISOString(),
        source.tenant_id,
        source.provider,
        event.external_id,
      )
      .run();
  } else {
    const issue = await createIssue(env, source.tenant_id, {
      project_id: source.project_id,
      title: event.title,
      description: event.description,
      priority: event.priority,
      assignee: event.assignee,
      origin: source.provider,
      external: {
        provider: source.provider,
        external_id: event.external_id,
        ...(event.external_url ? { external_url: event.external_url } : {}),
      },
    });
    issueId = issue.issue_id;
    const claim = await env.DB.prepare(
      `INSERT OR IGNORE INTO external_refs (tenant_id, provider, external_id, issue_id, external_url, source_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        source.tenant_id,
        source.provider,
        event.external_id,
        issueId,
        event.external_url ?? null,
        source.source_id,
      )
      .run();
    if (claim.meta.changes === 0) {
      // A concurrent delivery won the ref claim; converge on its issue. The
      // issue created above stays behind as an orphan — rare, documented.
      const winner = await env.DB.prepare(
        "SELECT issue_id FROM external_refs WHERE tenant_id = ? AND provider = ? AND external_id = ?",
      )
        .bind(source.tenant_id, source.provider, event.external_id)
        .first<{ issue_id: string }>();
      issueId = winner!.issue_id;
    }
  }

  const current = (await getIssue(env.DB, source.tenant_id, issueId))!;
  if (current.status !== event.status) {
    await alignStatus(env, source.tenant_id, issueId, event.status);
  }

  return { status: "processed", issue_id: issueId };
}
