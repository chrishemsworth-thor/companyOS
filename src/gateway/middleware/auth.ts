import type { Context, Next } from "hono";
import type { Env } from "../../env";
import type { Actor } from "../../auth/actor-context";

export interface Tenant {
  tenant_id: string;
  name: string;
}

export type AuthedEnv = {
  Bindings: Env;
  Variables: {
    tenant: Tenant;
    /**
     * The actor behind the request. Set by the session/API-key auth
     * middleware: a human `user` for cookie sessions, a `system` actor for
     * programmatic tenant-API-key callers. Optional so routes that predate
     * identity keep type-checking.
     */
    user?: Actor;
  };
};

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TENANT_CACHE_TTL_SECONDS = 60;

/**
 * Resolve a bearer API key to its tenant (D1 is truth, KV is a short-TTL
 * cache). Shared by `apiKeyAuth()` and the session middleware's bearer path.
 * Returns null when the key is unknown.
 */
export async function resolveTenantByApiKey(env: Env, apiKey: string): Promise<Tenant | null> {
  const keyHash = await sha256Hex(apiKey);
  const cacheKey = `tenant:by-key:${keyHash}`;

  const cached = await env.CONFIG_CACHE.get<Tenant>(cacheKey, "json");
  if (cached) return cached;

  const row = await env.DB.prepare(
    "SELECT tenant_id, name FROM tenants WHERE api_key_hash = ?",
  )
    .bind(keyHash)
    .first<Tenant>();
  if (!row) return null;

  await env.CONFIG_CACHE.put(cacheKey, JSON.stringify(row), {
    expirationTtl: TENANT_CACHE_TTL_SECONDS,
  });
  return row;
}

/**
 * API-key auth + tenant resolution.
 *
 * Clients present `Authorization: Bearer <api_key>`. The key is hashed and
 * looked up in D1 (source of truth); the resolved tenant is cached in KV for a
 * short TTL. KV is eventually consistent, so it is only ever a cache here —
 * key rotation takes effect within TENANT_CACHE_TTL_SECONDS + propagation.
 */
export function apiKeyAuth() {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const header = c.req.header("Authorization") ?? "";
    const apiKey = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!apiKey) {
      return c.json({ error: "missing Authorization: Bearer <api_key>" }, 401);
    }

    const tenant = await resolveTenantByApiKey(c.env, apiKey);
    if (!tenant) {
      return c.json({ error: "invalid api key" }, 401);
    }

    c.set("tenant", tenant);
    c.set("user", { type: "system" });
    return next();
  };
}
