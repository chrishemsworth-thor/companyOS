/**
 * Google OAuth 2.0 authorization-code flow — plain `fetch` against Google's
 * endpoints (no `googleapis` SDK, consistent with src/delivery/resend.ts's
 * Workers-native philosophy).
 *
 * Flow: buildAuthorizeUrl() → user consents at Google → callback receives a
 * `code` → exchangeCode() → { access_token, refresh_token, ... }. The refresh
 * token is stored (encrypted); access tokens are minted on demand via
 * refreshAccessToken() and cached in KV (see tokens.ts).
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenExchange {
  access_token: string;
  /** Present only when access_type=offline AND consent was (re)granted. */
  refresh_token?: string;
  expires_in: number;
  /** Space-separated scopes actually granted (may differ from requested). */
  scope: string;
  id_token?: string;
}

export interface UserInfo {
  sub: string;
  email: string;
}

/**
 * Build the consent URL. access_type=offline + prompt=consent guarantee a
 * refresh_token even on reconnect; include_granted_scopes keeps previously
 * granted scopes so a send-only account can add read later without a full reset.
 */
export function buildAuthorizeUrl(
  client: OAuthClient,
  opts: { scopes: string[]; state: string; loginHint?: string },
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: opts.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function postForm(fields: Record<string, string>): Promise<Response> {
  return fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

export async function exchangeCode(client: OAuthClient, code: string): Promise<TokenExchange> {
  const res = await postForm({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: "authorization_code",
  });
  if (!res.ok) {
    throw new Error(`google token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenExchange;
}

export interface RefreshedToken {
  access_token: string;
  expires_in: number;
  scope: string;
}

export async function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string,
): Promise<RefreshedToken> {
  const res = await postForm({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (!res.ok) {
    throw new Error(`google token refresh failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as RefreshedToken;
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`google userinfo failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { sub: string; email: string };
  return { sub: body.sub, email: body.email };
}

/** Best-effort revoke at Google's end. Callers still mark the row revoked. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}
