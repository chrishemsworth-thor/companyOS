import { ulid } from "../lib/ulid";
import { hashPassword, verifyPassword, type PasswordHash } from "./password";

/**
 * User service. Per-tenant human accounts with password credentials. Public
 * shapes never carry the password hash; the login path uses the private row.
 */

// Re-exported from the dependency-free leaf so existing importers are unaffected.
export { ROLES, type Role } from "./roles";
import type { Role } from "./roles";

export interface UserPublic {
  user_id: string;
  email: string;
  display_name: string | null;
  role: Role;
  /**
   * `invited` is derived, not stored: an active user with no password hash is
   * a pending invite (created without a password, waiting on invite/accept).
   * authenticateUser rejects null-hash users, so invited accounts can't log in.
   */
  status: "active" | "disabled" | "invited";
  created_at: string;
  last_login_at: string | null;
}

interface UserRow extends UserPublic {
  tenant_id: string;
  pwd_hash: string | null;
  pwd_salt: string | null;
  pwd_iter: number | null;
}

const PUBLIC_COLUMNS =
  "user_id, email, display_name, role, " +
  "CASE WHEN pwd_hash IS NULL AND status = 'active' THEN 'invited' ELSE status END AS status, " +
  "created_at, last_login_at";

export class UserError extends Error {
  constructor(
    readonly code: "email_taken" | "not_found" | "invalid_credentials" | "disabled",
    message: string,
    readonly httpStatus: 401 | 404 | 409 = 409,
  ) {
    super(message);
    this.name = "UserError";
  }
}

export async function createUser(
  db: D1Database,
  input: {
    tenant_id: string;
    email: string;
    /** Absent for invited users — they set their own via the invite link. */
    password?: string;
    display_name?: string;
    role?: Role;
  },
): Promise<UserPublic> {
  // Email is unique per company (migration 0012), so the duplicate check is
  // tenant-scoped — the same email may exist in a different company.
  const existing = await db
    .prepare("SELECT user_id FROM users WHERE tenant_id = ? AND email = ?")
    .bind(input.tenant_id, input.email)
    .first<{ user_id: string }>();
  if (existing) throw new UserError("email_taken", "email already registered", 409);

  const userId = `usr_${ulid()}`;
  const pwd = input.password === undefined ? null : await hashPassword(input.password);
  await db
    .prepare(
      `INSERT INTO users (user_id, tenant_id, email, display_name, role, pwd_hash, pwd_salt, pwd_iter)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      userId,
      input.tenant_id,
      input.email,
      input.display_name ?? null,
      input.role ?? "operator",
      pwd?.hash ?? null,
      pwd?.salt ?? null,
      pwd?.iterations ?? null,
    )
    .run();
  return (await getUserById(db, input.tenant_id, userId))!;
}

export async function getUserById(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<UserPublic | null> {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE tenant_id = ? AND user_id = ?`)
    .bind(tenantId, userId)
    .first<UserPublic>();
}

export async function listUsers(db: D1Database, tenantId: string): Promise<UserPublic[]> {
  const { results } = await db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE tenant_id = ? ORDER BY created_at`)
    .bind(tenantId)
    .all<UserPublic>();
  return results;
}

export async function updateUser(
  db: D1Database,
  tenantId: string,
  userId: string,
  patch: { display_name?: string; role?: Role; status?: "active" | "disabled" },
): Promise<UserPublic> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.display_name !== undefined) {
    sets.push("display_name = ?");
    binds.push(patch.display_name);
  }
  if (patch.role !== undefined) {
    sets.push("role = ?");
    binds.push(patch.role);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    binds.push(patch.status);
  }
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  const result = await db
    .prepare(`UPDATE users SET ${sets.join(", ")} WHERE tenant_id = ? AND user_id = ?`)
    .bind(...binds, tenantId, userId)
    .run();
  if (result.meta.changes === 0) throw new UserError("not_found", "user not found", 404);
  return (await getUserById(db, tenantId, userId))!;
}

/**
 * Set (or replace) a user's password credential. Used by invite-accept and
 * the reset/change flows — never by admins on behalf of someone else.
 */
export async function setPassword(
  db: D1Database,
  tenantId: string,
  userId: string,
  newPassword: string,
): Promise<void> {
  const pwd = await hashPassword(newPassword);
  const result = await db
    .prepare(
      "UPDATE users SET pwd_hash = ?, pwd_salt = ?, pwd_iter = ?, updated_at = ? WHERE tenant_id = ? AND user_id = ?",
    )
    .bind(pwd.hash, pwd.salt, pwd.iterations, new Date().toISOString(), tenantId, userId)
    .run();
  if (result.meta.changes === 0) throw new UserError("not_found", "user not found", 404);
}

/**
 * Change a logged-in user's own password: the current password must verify
 * first. Throws the same `invalid_credentials` as login on mismatch.
 */
export async function changePassword(
  db: D1Database,
  tenantId: string,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT pwd_hash, pwd_salt, pwd_iter FROM users WHERE tenant_id = ? AND user_id = ?",
    )
    .bind(tenantId, userId)
    .first<{ pwd_hash: string | null; pwd_salt: string | null; pwd_iter: number | null }>();
  if (!row || !row.pwd_hash || !row.pwd_salt || row.pwd_iter == null) {
    throw new UserError("invalid_credentials", "invalid current password", 401);
  }
  const ok = await verifyPassword(currentPassword, {
    hash: row.pwd_hash,
    salt: row.pwd_salt,
    iterations: row.pwd_iter,
  });
  if (!ok) throw new UserError("invalid_credentials", "invalid current password", 401);
  await setPassword(db, tenantId, userId, newPassword);
}

/**
 * Internal lookup for the forgot-password and resend-invite flows: exposes
 * just enough state to decide eligibility without leaking the credential.
 */
export async function getUserAuthState(
  db: D1Database,
  tenantId: string,
  by: { user_id: string } | { email: string },
): Promise<{ user_id: string; email: string; status: "active" | "disabled"; has_password: boolean } | null> {
  const where = "user_id" in by ? "user_id = ?" : "email = ?";
  const value = "user_id" in by ? by.user_id : by.email;
  const row = await db
    .prepare(
      `SELECT user_id, email, status, pwd_hash FROM users WHERE tenant_id = ? AND ${where}`,
    )
    .bind(tenantId, value)
    .first<{ user_id: string; email: string; status: "active" | "disabled"; pwd_hash: string | null }>();
  if (!row) return null;
  return {
    user_id: row.user_id,
    email: row.email,
    status: row.status,
    has_password: row.pwd_hash !== null,
  };
}

/**
 * Verify email + password within a company. Returns the public user on success.
 * Throws UserError('invalid_credentials') for both unknown-email and
 * wrong-password so the caller can't distinguish them, and 'disabled' for a
 * deactivated account. Login is scoped to a resolved tenant (migration 0012),
 * because email is only unique within a company.
 */
export async function authenticateUser(
  db: D1Database,
  tenantId: string,
  email: string,
  password: string,
): Promise<{ tenant_id: string; user: UserPublic }> {
  const row = await db
    .prepare(
      `SELECT ${PUBLIC_COLUMNS}, tenant_id, pwd_hash, pwd_salt, pwd_iter FROM users WHERE tenant_id = ? AND email = ?`,
    )
    .bind(tenantId, email)
    .first<UserRow>();
  if (!row || !row.pwd_hash || !row.pwd_salt || row.pwd_iter == null) {
    throw new UserError("invalid_credentials", "invalid email or password", 401);
  }
  const stored: PasswordHash = { hash: row.pwd_hash, salt: row.pwd_salt, iterations: row.pwd_iter };
  const ok = await verifyPassword(password, stored);
  if (!ok) throw new UserError("invalid_credentials", "invalid email or password", 401);
  if (row.status === "disabled") throw new UserError("disabled", "account disabled", 401);

  const { pwd_hash: _h, pwd_salt: _s, pwd_iter: _i, tenant_id, ...pub } = row;
  return { tenant_id, user: pub };
}

export async function touchLastLogin(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare("UPDATE users SET last_login_at = ? WHERE user_id = ?")
    .bind(new Date().toISOString(), userId)
    .run();
}
