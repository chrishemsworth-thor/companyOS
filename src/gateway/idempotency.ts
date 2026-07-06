import type { ContentfulStatusCode } from "hono/utils/http-status";

export class IdempotencyConflict extends Error {
  constructor(
    readonly code: "key_reused" | "in_progress",
    message: string,
    readonly httpStatus: 409 | 422,
  ) {
    super(message);
    this.name = "IdempotencyConflict";
  }
}

export interface IdempotentResult<T> {
  status: ContentfulStatusCode;
  body: T;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Wraps a write handler with `Idempotency-Key` semantics keyed on
 * (tenant_id, endpoint, key). Claims the key with a pending row *before*
 * running `handler`, so two concurrent requests with the same key can't
 * both execute — the loser gets a conflict instead of racing the write.
 * Agents retry, and double-recording a payment is the worst outcome here.
 *
 * - No key header → runs `handler` normally, no dedup.
 * - Unclaimed key → claims it, runs `handler`, stores the result (success or
 *   expected business error alike — both are deterministic replays of the
 *   same input) so a retry gets the identical response without re-running
 *   the write. An unexpected throw releases the claim so the retry isn't
 *   permanently stuck.
 * - Known key, same request body → replays the stored response; `handler`
 *   never runs.
 * - Known key, different request body → `IdempotencyConflict("key_reused")`.
 * - Known key, still in flight (racing request currently owns it) →
 *   `IdempotencyConflict("in_progress")`.
 */
export async function withIdempotency<T>(
  db: D1Database,
  tenantId: string,
  endpoint: string,
  key: string | undefined,
  requestBody: unknown,
  handler: () => Promise<IdempotentResult<T>>,
): Promise<IdempotentResult<T>> {
  if (!key) return handler();

  const requestHash = await sha256Hex(JSON.stringify(requestBody));

  const claim = await db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys (tenant_id, endpoint, idempotency_key, request_hash)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(tenantId, endpoint, key, requestHash)
    .run();

  if (claim.meta.changes === 0) {
    const row = await db
      .prepare(
        `SELECT request_hash, response_status, response_body FROM idempotency_keys
         WHERE tenant_id = ? AND endpoint = ? AND idempotency_key = ?`,
      )
      .bind(tenantId, endpoint, key)
      .first<{ request_hash: string; response_status: number | null; response_body: string | null }>();
    if (!row) {
      throw new Error(`idempotency key ${key} vanished between claim check and lookup`);
    }
    if (row.request_hash !== requestHash) {
      throw new IdempotencyConflict(
        "key_reused",
        `Idempotency-Key "${key}" was already used with a different request body`,
        422,
      );
    }
    if (row.response_status === null) {
      throw new IdempotencyConflict(
        "in_progress",
        `a request with Idempotency-Key "${key}" is already being processed`,
        409,
      );
    }
    return {
      status: row.response_status as ContentfulStatusCode,
      body: JSON.parse(row.response_body!) as T,
    };
  }

  try {
    const result = await handler();
    await db
      .prepare(
        `UPDATE idempotency_keys SET response_status = ?, response_body = ?
         WHERE tenant_id = ? AND endpoint = ? AND idempotency_key = ?`,
      )
      .bind(result.status, JSON.stringify(result.body), tenantId, endpoint, key)
      .run();
    return result;
  } catch (err) {
    // Unexpected failure: release the claim so a retry isn't stuck forever.
    await db
      .prepare(
        `DELETE FROM idempotency_keys WHERE tenant_id = ? AND endpoint = ? AND idempotency_key = ?`,
      )
      .bind(tenantId, endpoint, key)
      .run();
    throw err;
  }
}
