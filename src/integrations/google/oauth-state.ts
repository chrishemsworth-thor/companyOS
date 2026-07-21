import type { Env } from "../../env";
import type { GoogleAccountKind } from "./types";

/**
 * OAuth `state` handling. Rather than signing a self-contained token, we store
 * the connection intent in CONFIG_CACHE KV under an unguessable random nonce and
 * put only that nonce on the wire. The nonce is the CSRF binding — it is minted
 * inside the authenticated /connect call (so tenant/user are trusted), is
 * single-use (deleted on read at the callback), and expires after 10 minutes.
 * This keeps the tenant/user binding server-side and needs no extra secret.
 */

const STATE_TTL_SECONDS = 600;
const stateKey = (nonce: string) => `google-oauth-state:${nonce}`;

export interface OAuthState {
  tenant_id: string;
  kind: GoogleAccountKind;
  /** Owner for kind='user'; null for 'shared'. */
  user_id: string | null;
  label: string | null;
  /** Space-separated scopes requested (Gmail + identity). */
  scopes: string;
  /** The user who initiated the connect (audit trail). */
  connected_by_user_id: string | null;
  /** Exact redirect_uri used in the authorize request — reused at token exchange. */
  redirect_uri: string;
}

export async function createOAuthState(env: Env, state: OAuthState): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.CONFIG_CACHE.put(stateKey(nonce), JSON.stringify(state), {
    expirationTtl: STATE_TTL_SECONDS,
  });
  return nonce;
}

/** Read and consume (single-use) the state for a callback nonce. */
export async function consumeOAuthState(env: Env, nonce: string): Promise<OAuthState | null> {
  const raw = await env.CONFIG_CACHE.get(stateKey(nonce));
  if (!raw) return null;
  await env.CONFIG_CACHE.delete(stateKey(nonce));
  return JSON.parse(raw) as OAuthState;
}
