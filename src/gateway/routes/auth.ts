import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { authenticateUser, getUserById, UserError } from "../../auth/users";
import {
  createSession,
  isSecureRequest,
  readSessionCookie,
  resolveSession,
  revokeSession,
  sessionClearCookie,
  sessionSetCookie,
} from "../../auth/session";

/**
 * Session auth endpoints (the BFF login surface). Mounted BEFORE the /v1/*
 * `authenticate()` guard, so these are reachable without a session: login and
 * logout are public; `/me` does its own cookie check.
 */
export const auth = new Hono<AuthedEnv>();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(512),
});

auth.post("/login", zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  try {
    const { tenant_id, user } = await authenticateUser(c.env.DB, email, password);
    const { cookieValue, csrf_token } = await createSession(c.env, {
      tenant_id,
      user_id: user.user_id,
      role: user.role,
      user_agent: c.req.header("User-Agent") ?? undefined,
    });
    c.header("Set-Cookie", sessionSetCookie(cookieValue, isSecureRequest(c.req.raw)));
    return c.json({ user, csrf_token, tenant_id });
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
  const tenant = await c.env.DB.prepare("SELECT tenant_id, name FROM tenants WHERE tenant_id = ?")
    .bind(session.tenant_id)
    .first<{ tenant_id: string; name: string }>();
  return c.json({ user, tenant, csrf_token: session.csrf_token });
});
