import { ulid } from "../../lib/ulid";
import {
  ACCOUNT_PUBLIC_COLUMNS,
  type GoogleAccount,
  type GoogleAccountKind,
} from "./types";
import type { SealedToken } from "./crypto";

/**
 * google_accounts DAO (migration 0015). Every function is tenant-scoped and
 * filters by tenant_id — a bare account_id from a client is never trusted,
 * matching the getActiveSource/disableSource discipline in src/webhooks/sources.ts.
 * Token material (ciphertext/iv) is only ever read by loadSealedToken(), never
 * returned to callers of the public accessors.
 */

export interface UpsertAccountInput {
  tenant_id: string;
  kind: GoogleAccountKind;
  user_id: string | null;
  label: string | null;
  google_email: string;
  google_sub: string | null;
  scopes: string;
  sealed: SealedToken;
  connected_by_user_id: string | null;
}

/**
 * Find the existing account a fresh OAuth connection should update, honouring
 * the per-kind uniqueness (one personal connection per user; one shared
 * connection per mailbox address). Returns null for a first-time connection.
 */
async function findExistingId(
  db: D1Database,
  input: UpsertAccountInput,
): Promise<string | null> {
  const row =
    input.kind === "user"
      ? await db
          .prepare(
            "SELECT account_id FROM google_accounts WHERE tenant_id = ? AND kind = 'user' AND user_id = ?",
          )
          .bind(input.tenant_id, input.user_id)
          .first<{ account_id: string }>()
      : await db
          .prepare(
            "SELECT account_id FROM google_accounts WHERE tenant_id = ? AND kind = 'shared' AND google_email = ?",
          )
          .bind(input.tenant_id, input.google_email)
          .first<{ account_id: string }>();
  return row?.account_id ?? null;
}

/**
 * Create the account on first connect, or refresh its token/scopes/status on
 * reconnect. Reconnecting the same mailbox re-grants (prompt=consent always
 * yields a new refresh token) so the ciphertext is always replaced.
 */
export async function upsertAccount(
  db: D1Database,
  input: UpsertAccountInput,
): Promise<GoogleAccount> {
  const existingId = await findExistingId(db, input);

  if (existingId) {
    await db
      .prepare(
        `UPDATE google_accounts
           SET google_email = ?, google_sub = ?, scopes = ?,
               refresh_token_ciphertext = ?, refresh_token_iv = ?,
               label = COALESCE(?, label), status = 'active', last_error = NULL,
               connected_by_user_id = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE tenant_id = ? AND account_id = ?`,
      )
      .bind(
        input.google_email,
        input.google_sub,
        input.scopes,
        input.sealed.ciphertext,
        input.sealed.iv,
        input.label,
        input.connected_by_user_id,
        input.tenant_id,
        existingId,
      )
      .run();
    return (await getAccount(db, input.tenant_id, existingId))!;
  }

  const accountId = `gac_${ulid()}`;
  await db
    .prepare(
      `INSERT INTO google_accounts
         (account_id, tenant_id, kind, user_id, label, google_email, google_sub,
          scopes, refresh_token_ciphertext, refresh_token_iv, connected_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      accountId,
      input.tenant_id,
      input.kind,
      input.user_id,
      input.label,
      input.google_email,
      input.google_sub,
      input.scopes,
      input.sealed.ciphertext,
      input.sealed.iv,
      input.connected_by_user_id,
    )
    .run();
  return (await getAccount(db, input.tenant_id, accountId))!;
}

export async function getAccount(
  db: D1Database,
  tenantId: string,
  accountId: string,
): Promise<GoogleAccount | null> {
  return db
    .prepare(`SELECT ${ACCOUNT_PUBLIC_COLUMNS} FROM google_accounts WHERE tenant_id = ? AND account_id = ?`)
    .bind(tenantId, accountId)
    .first<GoogleAccount>();
}

export async function listAccounts(db: D1Database, tenantId: string): Promise<GoogleAccount[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ACCOUNT_PUBLIC_COLUMNS} FROM google_accounts WHERE tenant_id = ? ORDER BY created_at ASC`,
    )
    .bind(tenantId)
    .all<GoogleAccount>();
  return results;
}

/** Read the encrypted refresh token — internal to the token-refresh path only. */
export async function loadSealedToken(
  db: D1Database,
  tenantId: string,
  accountId: string,
): Promise<SealedToken | null> {
  const row = await db
    .prepare(
      "SELECT refresh_token_ciphertext AS ciphertext, refresh_token_iv AS iv FROM google_accounts WHERE tenant_id = ? AND account_id = ? AND status = 'active'",
    )
    .bind(tenantId, accountId)
    .first<SealedToken>();
  return row;
}

/** Mark an account revoked. Returns false when it doesn't exist for the tenant. */
export async function revokeAccount(
  db: D1Database,
  tenantId: string,
  accountId: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE google_accounts SET status = 'revoked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ? AND account_id = ?",
    )
    .bind(tenantId, accountId)
    .run();
  return res.meta.changes > 0;
}

/** Record a failure (e.g. a refresh that returned invalid_grant) on the row. */
export async function markAccountError(
  db: D1Database,
  tenantId: string,
  accountId: string,
  message: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE google_accounts SET status = 'error', last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ? AND account_id = ?",
    )
    .bind(message.slice(0, 500), tenantId, accountId)
    .run();
}
