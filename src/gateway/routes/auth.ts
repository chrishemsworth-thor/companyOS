import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import {
  authenticateUser,
  changePassword,
  getUserAuthState,
  getUserById,
  setPassword,
  UserError,
} from "../../auth/users";
import { resolveTenantBySlug } from "../../auth/tenants";
import {
  createSession,
  CSRF_HEADER,
  isSecureRequest,
  readSessionCookie,
  resolveSession,
  revokeAllUserSessions,
  revokeSession,
  sessionClearCookie,
  sessionSetCookie,
} from "../../auth/session";
import { consumeUserToken, issueUserToken, RESET_TTL_SECONDS } from "../../auth/tokens";
import { timingSafeEqualHex } from "../../auth/password";
import { sendEmail } from "../../delivery/dispatch";
import { passwordResetEmail } from "../../delivery/templates/user-emails";
import { consoleBaseUrl, resetPasswordPath } from "../../delivery/templates/links";
import { clientIp, rateLimit } from "../middleware/rate-limit";

/**
 * Session auth endpoints (the BFF login surface). Mounted BEFORE the /v1/*
 * `authenticate()` guard, so these are reachable without a session: login and
 * logout are public; `/me` does its own cookie check.
 */
export const auth = new Hono<AuthedEnv>();

/**
 * The tenant payload the console boots from. `onboarded_at` (null until the
 * first-run onboarding journey is finished or dismissed) lets the SPA decide
 * whether to redirect a company admin into /onboarding.
 */
async function sessionTenant(
  db: D1Database,
  tenantId: string,
): Promise<{ tenant_id: string; name: string; onboarded_at: string | null } | null> {
  return db
    .prepare("SELECT tenant_id, name, onboarded_at FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ tenant_id: string; name: string; onboarded_at: string | null }>();
}

const loginSchema = z.object({
  // The company/workspace slug. Email is only unique within a company, so login
  // must name which company to authenticate against (migration 0012).
  workspace: z.string().min(1).max(64),
  email: z.string().email(),
  password: z.string().min(1).max(512),
});

auth.post("/login", zValidator("json", loginSchema), async (c) => {
  const { workspace, email, password } = c.req.valid("json");
  try {
    const tenant = await resolveTenantBySlug(c.env.DB, workspace);
    // Unknown workspace is reported exactly like bad credentials so login can't
    // be used to enumerate which companies exist on the platform.
    if (!tenant) {
      return c.json({ error: "invalid email or password", code: "invalid_credentials" }, 401);
    }
    const { tenant_id, user } = await authenticateUser(c.env.DB, tenant.tenant_id, email, password);
    const { cookieValue, csrf_token } = await createSession(c.env, {
      tenant_id,
      user_id: user.user_id,
      role: user.role,
      user_agent: c.req.header("User-Agent") ?? undefined,
    });
    c.header("Set-Cookie", sessionSetCookie(cookieValue, isSecureRequest(c.req.raw)));
    return c.json({ user, csrf_token, tenant_id, tenant: await sessionTenant(c.env.DB, tenant_id) });
  } catch (err) {
    if (err instanceof UserError) return c.json({ error: err.message, code: err.code }, err.httpStatus);
    throw err;
  }
});

auth.post("/logout", async (c) => {
  const cookie = readSessionCookie(c.req.raw);
  if (cookie) await revokeSession(c.env, cookie);
  c.header("Set-Cookie", sessionClearCookie(isSecureRequest(c.req.raw)));
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const cookie = readSessionCookie(c.req.raw);
  const session = cookie ? await resolveSession(c.env, cookie) : null;
  if (!session) return c.json({ error: "not authenticated" }, 401);
  const user = await getUserById(c.env.DB, session.tenant_id, session.user_id);
  if (!user) return c.json({ error: "not authenticated" }, 401);
  const tenant = await sessionTenant(c.env.DB, session.tenant_id);
  return c.json({ user, tenant, csrf_token: session.csrf_token });
});

// ---------------------------------------------------------------------------
// User lifecycle: invite acceptance + password reset/change.
// All token failures are the same generic `invalid_token` — expired, used,
// and unknown are deliberately indistinguishable (no probing oracle).
// ---------------------------------------------------------------------------

const passwordSchema = z.string().min(8).max(512);

const acceptInviteSchema = z.object({
  token: z.string().min(16).max(256),
  password: passwordSchema,
  display_name: z.string().min(1).max(200).optional(),
});

auth.post("/invite/accept", zValidator("json", acceptInviteSchema), async (c) => {
  if (!(await rateLimit(c.env.SESSIONS, `accept:ip:${clientIp(c.req.raw)}`, 20, 3600))) {
    return c.json({ error: "too many attempts, try again later", code: "rate_limited" }, 429);
  }
  const { token, password, display_name } = c.req.valid("json");

  const consumed = await consumeUserToken(c.env.DB, token, "invite");
  if (!consumed) {
    return c.json({ error: "invalid or expired invite link", code: "invalid_token" }, 400);
  }
  const state = await getUserAuthState(c.env.DB, consumed.tenant_id, {
    user_id: consumed.user_id,
  });
  if (!state || state.status === "disabled") {
    return c.json({ error: "invalid or expired invite link", code: "invalid_token" }, 400);
  }

  await setPassword(c.env.DB, consumed.tenant_id, consumed.user_id, password);
  if (display_name) {
    await c.env.DB.prepare(
      "UPDATE users SET display_name = ?, updated_at = ? WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(display_name, new Date().toISOString(), consumed.tenant_id, consumed.user_id)
      .run();
  }

  // Sign the new user straight in — same response shape as /login so the SPA
  // can reuse its login completion path.
  const user = (await getUserById(c.env.DB, consumed.tenant_id, consumed.user_id))!;
  const { cookieValue, csrf_token } = await createSession(c.env, {
    tenant_id: consumed.tenant_id,
    user_id: user.user_id,
    role: user.role,
    user_agent: c.req.header("User-Agent") ?? undefined,
  });
  c.header("Set-Cookie", sessionSetCookie(cookieValue, isSecureRequest(c.req.raw)));
  return c.json({
    user,
    csrf_token,
    tenant_id: consumed.tenant_id,
    tenant: await sessionTenant(c.env.DB, consumed.tenant_id),
  });
});

const forgotSchema = z.object({
  workspace: z.string().min(1).max(64),
  email: z.string().email(),
});

auth.post("/password/forgot", zValidator("json", forgotSchema), async (c) => {
  const { workspace, email } = c.req.valid("json");
  // Always 200 — like /login's anti-enumeration 401, this endpoint never
  // reveals whether the workspace or account exists. Rate limiting silently
  // skips the send instead of erroring, for the same reason.
  const ok = c.json({ ok: true });

  const ipAllowed = await rateLimit(c.env.SESSIONS, `forgot:ip:${clientIp(c.req.raw)}`, 10, 3600);
  const acctAllowed = await rateLimit(c.env.SESSIONS, `forgot:acct:${workspace}:${email}`, 3, 3600);
  if (!ipAllowed || !acctAllowed) return ok;

  try {
    const tenant = await resolveTenantBySlug(c.env.DB, workspace);
    if (!tenant) return ok;
    const state = await getUserAuthState(c.env.DB, tenant.tenant_id, { email });
    // Only active accounts with an established password can reset. Invited
    // users have a live invite link instead; disabled accounts stay locked.
    if (!state || state.status !== "active" || !state.has_password) return ok;

    const { raw } = await issueUserToken(c.env.DB, {
      tenant_id: tenant.tenant_id,
      user_id: state.user_id,
      purpose: "password_reset",
      ttlSeconds: RESET_TTL_SECONDS,
    });
    const rendered = passwordResetEmail({
      tenantName: tenant.name,
      resetUrl: consoleBaseUrl(c.env) + resetPasswordPath(raw),
      expiresMinutes: RESET_TTL_SECONDS / 60,
    });
    await sendEmail(c.env, tenant.tenant_id, {
      to: state.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      purpose: "password_reset",
      refs: { user_id: state.user_id },
    });
  } catch (err) {
    // Never surface internal failures (including send failures) to the caller.
    console.error("password/forgot failed:", err instanceof Error ? err.message : err);
  }
  return ok;
});

const resetSchema = z.object({
  token: z.string().min(16).max(256),
  password: passwordSchema,
});

auth.post("/password/reset", zValidator("json", resetSchema), async (c) => {
  if (!(await rateLimit(c.env.SESSIONS, `reset:ip:${clientIp(c.req.raw)}`, 20, 3600))) {
    return c.json({ error: "too many attempts, try again later", code: "rate_limited" }, 429);
  }
  const { token, password } = c.req.valid("json");

  const consumed = await consumeUserToken(c.env.DB, token, "password_reset");
  if (!consumed) {
    return c.json({ error: "invalid or expired reset link", code: "invalid_token" }, 400);
  }
  const state = await getUserAuthState(c.env.DB, consumed.tenant_id, {
    user_id: consumed.user_id,
  });
  if (!state || state.status === "disabled") {
    return c.json({ error: "invalid or expired reset link", code: "invalid_token" }, 400);
  }

  await setPassword(c.env.DB, consumed.tenant_id, consumed.user_id, password);
  // A reset implies the old credential may be compromised: drop every live
  // session and make the new password prove itself through a fresh login.
  await revokeAllUserSessions(c.env, consumed.user_id);
  return c.json({ ok: true });
});

const changeSchema = z.object({
  current_password: z.string().min(1).max(512),
  new_password: passwordSchema,
});

auth.post("/password/change", zValidator("json", changeSchema), async (c) => {
  // This route sits before the /v1 authenticate() guard, so it does its own
  // session + CSRF checks, the same way /me does its own cookie check.
  const cookie = readSessionCookie(c.req.raw);
  const session = cookie ? await resolveSession(c.env, cookie) : null;
  if (!session) return c.json({ error: "not authenticated" }, 401);
  const header = c.req.header(CSRF_HEADER) ?? "";
  if (!header || !timingSafeEqualHex(header, session.csrf_token)) {
    return c.json({ error: "missing or invalid CSRF token" }, 403);
  }

  const { current_password, new_password } = c.req.valid("json");
  try {
    await changePassword(c.env.DB, session.tenant_id, session.user_id, current_password, new_password);
  } catch (err) {
    if (err instanceof UserError) return c.json({ error: err.message, code: err.code }, err.httpStatus);
    throw err;
  }
  // User-initiated change with the current password known: other sessions
  // stay valid (unlike reset, which assumes compromise).
  return c.json({ ok: true });
});
