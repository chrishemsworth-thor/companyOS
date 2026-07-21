import type { Env } from "../../env";
import { decryptRefreshToken } from "./crypto";
import { loadSealedToken, markAccountError } from "./accounts";
import { refreshAccessToken, type OAuthClient } from "./oauth";
import type { GoogleAccount } from "./types";

/**
 * Resolve a usable access token for a connected account. Access tokens are
 * short-lived (~1h) and never persisted in D1; they are cached in CONFIG_CACHE
 * KV (key `google-access-token:<account_id>`, TTL = expires_in − 60s), mirroring
 * the D1-truth/KV-cache pattern used for API-key → tenant resolution
 * (src/gateway/middleware/auth.ts). On a cache miss the stored refresh token is
 * decrypted and exchanged for a fresh access token.
 */

export class GoogleTokenError extends Error {
  constructor(
    readonly code: "not_configured" | "no_credentials" | "refresh_failed",
    message: string,
  ) {
    super(message);
    this.name = "GoogleTokenError";
  }
}

/**
 * Build the OAuth client config from env, or throw when Google isn't configured.
 * `redirectUri` matters only to the authorize/code-exchange flow; token REFRESH
 * never sends it, so this path leaves it empty.
 */
export function oauthClient(env: Env): OAuthClient {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_TOKEN_ENCRYPTION_KEY) {
    throw new GoogleTokenError("not_configured", "google integration is not configured");
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: "",
  };
}

export const accessTokenCacheKey = (accountId: string) => `google-access-token:${accountId}`;

export async function getAccessToken(env: Env, account: GoogleAccount): Promise<string> {
  const cacheKey = accessTokenCacheKey(account.account_id);
  const cached = await env.CONFIG_CACHE.get(cacheKey);
  if (cached) return cached;

  const client = oauthClient(env);
  const sealed = await loadSealedToken(env.DB, account.tenant_id, account.account_id);
  if (!sealed) {
    throw new GoogleTokenError("no_credentials", "account has no stored credentials (revoked?)");
  }

  const refreshToken = await decryptRefreshToken(env.GOOGLE_TOKEN_ENCRYPTION_KEY!, sealed);
  try {
    const refreshed = await refreshAccessToken(client, refreshToken);
    // KV requires a minimum 60s TTL; Google access tokens last ~3600s.
    const ttl = Math.max(60, refreshed.expires_in - 60);
    await env.CONFIG_CACHE.put(cacheKey, refreshed.access_token, { expirationTtl: ttl });
    return refreshed.access_token;
  } catch (err) {
    // A hard refresh failure (e.g. the user revoked access at Google) is
    // terminal — flag the account so operators see it needs reconnecting.
    const message = err instanceof Error ? err.message : String(err);
    await markAccountError(env.DB, account.tenant_id, account.account_id, message);
    throw new GoogleTokenError("refresh_failed", message);
  }
}
