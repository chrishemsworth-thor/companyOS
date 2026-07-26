import { Hono } from "hono";
import type { Env } from "../../env";
import { consumeOAuthState } from "../../integrations/google/oauth-state";
import { exchangeCode, fetchUserInfo } from "../../integrations/google/oauth";
import { encryptRefreshToken } from "../../integrations/google/crypto";
import { upsertAccount } from "../../integrations/google/accounts";

/**
 * Google OAuth callback — mounted at /oauth/google, OUTSIDE the /v1
 * authenticate() guard, because Google redirects the browser here with no
 * Authorization header. Trust comes instead from the single-use `state` nonce,
 * which was minted inside the authenticated /connect call and carries the
 * tenant/user binding server-side (see oauth-state.ts). This is analogous in
 * spirit to the unauthenticated /webhooks ingress, which self-authenticates on
 * a per-source secret.
 */
export const googleOAuth = new Hono<{ Bindings: Env }>();

/**
 * Escape a string for safe interpolation into HTML text context. This page
 * renders values derived from request input (the OAuth `?error=` param, an
 * exchange exception's message), so every interpolated value is escaped
 * unconditionally — the callback must never reflect attacker-supplied markup.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, message: string, ok: boolean): Response {
  const t = escapeHtml(title);
  const m = escapeHtml(message);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { max-width: 28rem; padding: 2rem; background: #1e293b; border-radius: 12px;
          text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; color: ${ok ? "#4ade80" : "#f87171"}; }
  p { margin: 0; color: #94a3b8; line-height: 1.5; }
</style></head>
<body><div class="card"><h1>${t}</h1><p>${m}</p></div></body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Defence-in-depth: the page has no scripts and loads no external
      // resources, so a strict CSP neutralises any future markup-injection
      // regression on this unauthenticated endpoint.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

googleOAuth.get("/callback", async (c) => {
  const url = new URL(c.req.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return page("Connection cancelled", `Google reported: ${oauthError}.`, false);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return page("Invalid request", "The callback was missing its authorization code.", false);
  }

  const intent = await consumeOAuthState(c.env, state);
  if (!intent) {
    return page(
      "Link expired",
      "This connection link has expired or was already used. Please start again from CompanyOS.",
      false,
    );
  }

  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_TOKEN_ENCRYPTION_KEY) {
    return page("Not configured", "Google integration is not configured on this server.", false);
  }

  try {
    const client = {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: intent.redirect_uri,
    };
    const tokens = await exchangeCode(client, code);
    if (!tokens.refresh_token) {
      // Without offline consent there is no long-lived credential to store.
      return page(
        "Reconnect needed",
        "Google did not return a refresh token. Remove CompanyOS from your Google Account's third-party access, then connect again.",
        false,
      );
    }
    const info = await fetchUserInfo(tokens.access_token);
    const sealed = await encryptRefreshToken(c.env.GOOGLE_TOKEN_ENCRYPTION_KEY, tokens.refresh_token);
    await upsertAccount(c.env.DB, {
      tenant_id: intent.tenant_id,
      kind: intent.kind,
      user_id: intent.user_id,
      label: intent.label,
      google_email: info.email,
      google_sub: info.sub,
      scopes: tokens.scope,
      sealed,
      connected_by_user_id: intent.connected_by_user_id,
    });
    return page(
      "Connected",
      `${info.email} is now connected to CompanyOS. You can close this window.`,
      true,
    );
  } catch (err) {
    return page(
      "Connection failed",
      `Something went wrong completing the connection: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }
});
