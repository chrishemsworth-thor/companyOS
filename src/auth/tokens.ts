import { sha256Hex } from "../gateway/middleware/auth";

/**
 * Single-use user lifecycle tokens: invites and password resets. Same
 * discipline as sessions (src/auth/session.ts) — 32 random bytes, only
 * sha256(raw) is stored; the raw token exists exactly once, inside the
 * emailed link. Consumption is a single conditional UPDATE, so a token can
 * never be redeemed twice even under concurrent requests.
 */

export type TokenPurpose = "invite" | "password_reset";

export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const RESET_TTL_SECONDS = 60 * 60; // 1 hour

const TOKEN_BYTES = 32;

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Issue a fresh token for (user, purpose), invalidating any still-live ones —
 * resending an invite kills the previous link. Returns the raw token (the
 * only time it exists) and its expiry.
 */
export async function issueUserToken(
  db: D1Database,
  input: {
    tenant_id: string;
    user_id: string;
    purpose: TokenPurpose;
    ttlSeconds: number;
    created_by?: string;
  },
): Promise<{ raw: string; expires_at: string }> {
  const raw = randomHex(TOKEN_BYTES);
  const tokenHash = await sha256Hex(raw);
  const now = new Date();
  const expires_at = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();

  await db.batch([
    db
      .prepare(
        "UPDATE user_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL",
      )
      .bind(now.toISOString(), input.user_id, input.purpose),
    db
      .prepare(
        `INSERT INTO user_tokens (token_hash, tenant_id, user_id, purpose, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tokenHash,
        input.tenant_id,
        input.user_id,
        input.purpose,
        expires_at,
        input.created_by ?? null,
      ),
  ]);

  return { raw, expires_at };
}

/**
 * Atomically consume a token: marks it used iff it is live (unused and not
 * expired) and returns its owner, or null for anything else — unknown,
 * expired, and already-used tokens are indistinguishable to the caller by
 * design (no oracle for probing).
 */
export async function consumeUserToken(
  db: D1Database,
  raw: string,
  purpose: TokenPurpose,
): Promise<{ tenant_id: string; user_id: string } | null> {
  const tokenHash = await sha256Hex(raw);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE user_tokens SET used_at = ?
       WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .bind(now, tokenHash, purpose, now)
    .run();
  if (result.meta.changes !== 1) return null;
  return db
    .prepare("SELECT tenant_id, user_id FROM user_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ tenant_id: string; user_id: string }>();
}
