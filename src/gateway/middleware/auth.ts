import type { Context, Next } from "hono";
import type { Env } from "../../env";

export interface Tenant {
  tenant_id: string;
  name: string;
}

export type AuthedEnv = {
  Bindings: Env;
  Variables: { tenant: Tenant };
};

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TENANT_CACHE_TTL_SECONDS = 60;

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

    const keyHash = await sha256Hex(apiKey);
    const cacheKey = `tenant:by-key:${keyHash}`;

    const cached = await c.env.CONFIG_CACHE.get<Tenant>(cacheKey, "json");
    if (cached) {
      c.set("tenant", cached);
      return next();
    }

    const row = await c.env.DB.prepare(
      "SELECT tenant_id, name FROM tenants WHERE api_key_hash = ?",
    )
      .bind(keyHash)
      .first<Tenant>();
    if (!row) {
      return c.json({ error: "invalid api key" }, 401);
    }

    await c.env.CONFIG_CACHE.put(cacheKey, JSON.stringify(row), {
      expirationTtl: TENANT_CACHE_TTL_SECONDS,
    });
    c.set("tenant", row);
    return next();
  };
}
