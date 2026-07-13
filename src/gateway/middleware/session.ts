import type { Context, MiddlewareHandler, Next } from "hono";
import type { AuthedEnv } from "./auth";
import { resolveTenantByApiKey } from "./auth";
import type { Actor } from "../../auth/actor-context";
import { runWithActor } from "../../auth/actor-context";
import { timingSafeEqualHex } from "../../auth/password";
import {
  CSRF_HEADER,
  readSessionCookie,
  resolveSession,
  type SessionData,
} from "../../auth/session";

/** Methods that mutate state and therefore require a CSRF token on cookie auth. */
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function setActor(c: Context<AuthedEnv>, tenantId: string, actor: Actor): void {
  c.set("tenant", { tenant_id: tenantId, name: tenantId });
  c.set("user", actor);
}

/**
 * Cookie-session authentication. Resolves the session to a tenant + human user
 * and enforces a synchronizer CSRF token on mutating requests. Returns the
 * resolved session on success, or a Response to short-circuit on failure.
 */
async function trySession(c: Context<AuthedEnv>): Promise<SessionData | Response | null> {
  const cookie = readSessionCookie(c.req.raw);
  if (!cookie) return null; // no session cookie — let the caller try bearer auth
  const session = await resolveSession(c.env, cookie);
  if (!session) return c.json({ error: "invalid or expired session" }, 401);

  if (MUTATING.has(c.req.method)) {
    const header = c.req.header(CSRF_HEADER) ?? "";
    if (!header || !timingSafeEqualHex(header, session.csrf_token)) {
      return c.json({ error: "missing or invalid CSRF token" }, 403);
    }
  }
  return session;
}

/**
 * Unified authentication for /v1/* business routes: a session cookie (humans
 * via the operator UI) OR an `Authorization: Bearer <api_key>` (agents and
 * programmatic callers). Sets `tenant` and the acting `user`, and runs the
 * downstream handler inside an actor context so emitted events are attributed
 * without threading an actor through every service call.
 */
export function authenticate(): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    const session = await trySession(c);
    if (session instanceof Response) return session;
    if (session) {
      const actor: Actor = { type: "user", id: session.user_id, role: session.role };
      setActor(c, session.tenant_id, actor);
      return runWithActor(actor, next);
    }

    const header = c.req.header("Authorization") ?? "";
    const apiKey = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!apiKey) {
      return c.json({ error: "authentication required (session cookie or Bearer api key)" }, 401);
    }
    const tenant = await resolveTenantByApiKey(c.env, apiKey);
    if (!tenant) return c.json({ error: "invalid api key" }, 401);

    const actor: Actor = { type: "system" };
    c.set("tenant", tenant);
    c.set("user", actor);
    return runWithActor(actor, next);
  };
}

/**
 * Restrict a route to human users holding one of `roles`. Programmatic callers
 * (tenant API key → `system` actor) are trusted root credentials and bypass the
 * check. Phase-2 policy applies this only to admin surfaces (e.g. /v1/users);
 * per-route business gating is layered in later without touching call sites.
 */
export function requireRole(...roles: string[]): MiddlewareHandler<AuthedEnv> {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const user = c.get("user");
    if (!user || user.type !== "user") return next(); // system/agent bypass
    if (user.role && roles.includes(user.role)) return next();
    return c.json({ error: "forbidden: requires role " + roles.join("|") }, 403);
  };
}
