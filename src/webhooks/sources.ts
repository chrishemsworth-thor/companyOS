import { ulid } from "../lib/ulid";
import { BuildError, getProject } from "../modules/build/service";
import type { WebhookProvider, WebhookSource } from "./types";

/** webhook_sources DAO (migration 0014). */

const SOURCE_COLUMNS =
  "source_id, tenant_id, provider, project_id, external_project_key, status, created_at";

export async function createWebhookSource(
  db: D1Database,
  tenantId: string,
  input: { provider: WebhookProvider; project_id: string; external_project_key?: string },
): Promise<WebhookSource> {
  const project = await getProject(db, tenantId, input.project_id);
  if (!project) throw new BuildError("not_found", `project ${input.project_id} not found`, 404);

  const sourceId = `whs_${ulid()}`;
  await db
    .prepare(
      `INSERT INTO webhook_sources (source_id, tenant_id, provider, project_id, external_project_key)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(sourceId, tenantId, input.provider, input.project_id, input.external_project_key ?? null)
    .run();

  return (await db
    .prepare(`SELECT ${SOURCE_COLUMNS} FROM webhook_sources WHERE source_id = ?`)
    .bind(sourceId)
    .first<WebhookSource>())!;
}

/**
 * Look up a source by its URL token alone (the tenant comes from the row).
 * Returns null for unknown or disabled sources — callers 404 both uniformly
 * so the endpoint doesn't reveal which tokens exist.
 */
export async function getActiveSource(
  db: D1Database,
  sourceId: string,
): Promise<WebhookSource | null> {
  return db
    .prepare(`SELECT ${SOURCE_COLUMNS} FROM webhook_sources WHERE source_id = ? AND status = 'active'`)
    .bind(sourceId)
    .first<WebhookSource>();
}

export async function listSources(db: D1Database, tenantId: string): Promise<WebhookSource[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SOURCE_COLUMNS} FROM webhook_sources WHERE tenant_id = ? ORDER BY source_id ASC`,
    )
    .bind(tenantId)
    .all<WebhookSource>();
  return results;
}

/** Returns false when the source doesn't exist for this tenant. */
export async function disableSource(
  db: D1Database,
  tenantId: string,
  sourceId: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE webhook_sources SET status = 'disabled' WHERE tenant_id = ? AND source_id = ?",
    )
    .bind(tenantId, sourceId)
    .run();
  return res.meta.changes > 0;
}
