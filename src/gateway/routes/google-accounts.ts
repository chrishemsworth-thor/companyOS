import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { buildAuthorizeUrl, revokeToken } from "../../integrations/google/oauth";
import { createOAuthState } from "../../integrations/google/oauth-state";
import {
  getAccount,
  listAccounts,
  loadSealedToken,
  revokeAccount,
} from "../../integrations/google/accounts";
import { decryptRefreshToken } from "../../integrations/google/crypto";
import {
  accessTokenCacheKey,
  getAccessToken,
  GoogleTokenError,
} from "../../integrations/google/tokens";
import { sendGmailMessage } from "../../integrations/google/gmail-client";
import {
  GMAIL_SEND_SCOPE,
  gmailScopesFor,
  hasScope,
  IDENTITY_SCOPES,
  type GoogleAccount,
} from "../../integrations/google/types";
import type { Actor } from "../../auth/actor-context";
import type { Context } from "hono";

/**
 * Tenant-scoped provisioning + use of connected Google (Gmail) accounts.
 *   POST   /v1/google-accounts/connect   → returns a Google authorize URL
 *   GET    /v1/google-accounts           → list connected accounts (no tokens)
 *   POST   /v1/google-accounts/:id/send  → send an email as the account
 *   DELETE /v1/google-accounts/:id       → revoke the connection
 *
 * The OAuth callback that completes a connection lives OUTSIDE /v1 (no bearer
 * token on a browser redirect) — see src/gateway/routes/google-oauth.ts.
 */
export const googleAccounts = new Hono<AuthedEnv>();

function googleConfigured(env: AuthedEnv["Bindings"]): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_TOKEN_ENCRYPTION_KEY);
}

/** The redirect_uri: an explicit override, else derived from the request origin. */
function redirectUri(c: Context<AuthedEnv>): string {
  return c.env.GOOGLE_OAUTH_REDIRECT_URI ?? `${new URL(c.req.url).origin}/oauth/google/callback`;
}

/**
 * A personal ('user') account is private to its owner: usable and visible only
 * by the human who connected it. Shared accounts belong to the whole tenant.
 * Programmatic (API-key/system) callers may use shared accounts but never
 * personal ones — impersonating a colleague's mailbox is not a tenant-root power.
 */
function canUsePersonal(account: GoogleAccount, actor: Actor | undefined): boolean {
  return actor?.type === "user" && account.user_id === actor.id;
}

const connectSchema = z.object({
  kind: z.enum(["shared", "user"]),
  label: z.string().min(1).max(200).optional(),
  access: z.enum(["send", "send_and_read"]).default("send"),
});

googleAccounts.post("/connect", zValidator("json", connectSchema), async (c) => {
  if (!googleConfigured(c.env)) {
    return c.json({ error: "google integration is not configured" }, 503);
  }
  const tenant = c.get("tenant");
  const actor = c.get("user");
  const { kind, label, access } = c.req.valid("json");

  let userId: string | null = null;
  if (kind === "user") {
    if (actor?.type !== "user" || !actor.id) {
      return c.json({ error: "a 'user' connection must be initiated by a signed-in user" }, 400);
    }
    userId = actor.id;
  }
  const connectedBy = actor?.type === "user" ? (actor.id ?? null) : null;

  const scopes = [...gmailScopesFor(access), ...IDENTITY_SCOPES];
  const uri = redirectUri(c);
  const state = await createOAuthState(c.env, {
    tenant_id: tenant.tenant_id,
    kind,
    user_id: userId,
    label: label ?? null,
    scopes: scopes.join(" "),
    connected_by_user_id: connectedBy,
    redirect_uri: uri,
  });

  const authorize_url = buildAuthorizeUrl(
    {
      clientId: c.env.GOOGLE_CLIENT_ID!,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET!,
      redirectUri: uri,
    },
    { scopes, state },
  );
  return c.json({ authorize_url }, 201);
});

googleAccounts.get("/", async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  const all = await listAccounts(c.env.DB, tenant.tenant_id);
  const visible = all.filter((a) => a.kind === "shared" || canUsePersonal(a, actor));
  return c.json({ google_accounts: visible });
});

const sendSchema = z
  .object({
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    subject: z.string().min(1).max(2000),
    body_text: z.string().optional(),
    body_html: z.string().optional(),
    thread_id: z.string().optional(),
  })
  .refine((v) => Boolean(v.body_text || v.body_html), {
    message: "body_text or body_html is required",
  });

googleAccounts.post("/:id/send", zValidator("json", sendSchema), async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  const account = await getAccount(c.env.DB, tenant.tenant_id, c.req.param("id"));
  // Not-found and not-authorized collapse to 404 so personal accounts don't
  // leak their existence to non-owners.
  if (!account || account.status !== "active") {
    return c.json({ error: "google account not found" }, 404);
  }
  if (account.kind === "user" && !canUsePersonal(account, actor)) {
    return c.json({ error: "google account not found" }, 404);
  }
  if (!hasScope(account.scopes, GMAIL_SEND_SCOPE)) {
    return c.json({ error: "account is not authorized to send — reconnect with send access", code: "missing_scope" }, 403);
  }

  const body = c.req.valid("json");
  try {
    const accessToken = await getAccessToken(c.env, account, redirectUri(c));
    const result = await sendGmailMessage(accessToken, {
      from: account.google_email,
      to: body.to,
      cc: body.cc,
      subject: body.subject,
      bodyText: body.body_text,
      bodyHtml: body.body_html,
      threadId: body.thread_id,
    });
    return c.json({ delivery_ref: result.id, thread_id: result.threadId });
  } catch (err) {
    if (err instanceof GoogleTokenError) {
      return c.json({ error: err.message, code: err.code }, err.code === "not_configured" ? 503 : 502);
    }
    return c.json(
      { error: `gmail send failed: ${err instanceof Error ? err.message : String(err)}` },
      502,
    );
  }
});

googleAccounts.delete("/:id", async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  const account = await getAccount(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!account) return c.json({ error: "google account not found" }, 404);
  if (account.kind === "user" && !canUsePersonal(account, actor)) {
    return c.json({ error: "google account not found" }, 404);
  }

  // Best-effort revoke at Google before dropping our stored credential.
  if (account.status === "active" && c.env.GOOGLE_TOKEN_ENCRYPTION_KEY) {
    const sealed = await loadSealedToken(c.env.DB, tenant.tenant_id, account.account_id);
    if (sealed) {
      try {
        const token = await decryptRefreshToken(c.env.GOOGLE_TOKEN_ENCRYPTION_KEY, sealed);
        await revokeToken(token);
      } catch {
        // Google-side revoke is best-effort; we still mark it revoked locally.
      }
    }
  }
  await revokeAccount(c.env.DB, tenant.tenant_id, account.account_id);
  await c.env.CONFIG_CACHE.delete(accessTokenCacheKey(account.account_id));
  return c.json({ status: "revoked" });
});
