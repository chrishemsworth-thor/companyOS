import type { Env } from "../env";
import { sha256Hex } from "../gateway/middleware/auth";
import { timingSafeEqualHex } from "./password";

/**
 * Server-side session layer (the "BFF" in the plan). A login mints an opaque
 * random token; the browser only ever holds `token.hmac` in an HttpOnly cookie.
 * The tenant API key never reaches the browser.
 *
 * Storage mirrors the tenant-auth pattern in gateway/middleware/auth.ts:
 *   - KV (`SESSIONS`) is the hot lookup, keyed by sha256(token) with a TTL.
 *   - D1 `sessions` is the durable, revocable, listable source of truth.
 * We store sha256(token), never the raw token — same discipline as api_key_hash.
 */

export const SESSION_COOKIE = "cos_session";
export const CSRF_HEADER = "X-CSRF-Token";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days absolute
const TOKEN_BYTES = 32;

export interface SessionData {
  tenant_id: string;
  user_id: string;
  role: string;
  csrf_token: string;
  expires_at: string;
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signToken(token: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return `${token}.${base64url(sig)}`;
}

/** Verify the HMAC on a `token.sig` cookie value; returns the token or null. */
async function verifySignedToken(signed: string, secret: string): Promise<string | null> {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const token = signed.slice(0, dot);
  const expected = await signToken(token, secret);
  // Constant-time compare of the whole signed value.
  return timingSafeEqualHex(hexEncode(signed), hexEncode(expected)) ? token : null;
}

// timingSafeEqualHex compares hex strings; encode arbitrary strings to hex so
// the signature comparison stays constant-time and length-safe.
function hexEncode(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, "0");
  return out;
}

/**
 * Create a session for a user: mint token + CSRF token, write the KV hot copy
 * (with TTL) and the durable D1 row. Returns the signed cookie value the
 * caller sets, plus the CSRF token to hand to the client.
 */
export async function createSession(
  env: Env,
  input: { tenant_id: string; user_id: string; role: string; user_agent?: string },
): Promise<{ cookieValue: string; csrf_token: string; expires_at: string }> {
  const token = randomHex(TOKEN_BYTES);
  const csrf_token = randomHex(TOKEN_BYTES);
  const sessionHash = await sha256Hex(token);
  const expiresMs = Date.now() + SESSION_TTL_SECONDS * 1000;
  const expires_at = new Date(expiresMs).toISOString();

  const data: SessionData = {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    role: input.role,
    csrf_token,
    expires_at,
  };
  await env.SESSIONS.put(`session:${sessionHash}`, JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  await env.DB.prepare(
    `INSERT INTO sessions (session_hash, tenant_id, user_id, csrf_token, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(sessionHash, input.tenant_id, input.user_id, csrf_token, expires_at, input.user_agent ?? null)
    .run();

  return { cookieValue: await signToken(token, env.SESSION_SECRET), csrf_token, expires_at };
}

/** Resolve a signed cookie value to its session, or null if invalid/expired. */
export async function resolveSession(env: Env, cookieValue: string): Promise<SessionData | null> {
  const token = await verifySignedToken(cookieValue, env.SESSION_SECRET);
  if (!token) return null;
  const sessionHash = await sha256Hex(token);
  const data = await env.SESSIONS.get<SessionData>(`session:${sessionHash}`, "json");
  if (!data) return null;
  if (Date.parse(data.expires_at) <= Date.now()) return null;
  return data;
}

/** Revoke a session: drop the KV hot copy and mark the D1 row revoked. */
export async function revokeSession(env: Env, cookieValue: string): Promise<void> {
  const token = await verifySignedToken(cookieValue, env.SESSION_SECRET);
  if (!token) return;
  const sessionHash = await sha256Hex(token);
  await env.SESSIONS.delete(`session:${sessionHash}`);
  await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL",
  )
    .bind(new Date().toISOString(), sessionHash)
    .run();
}

/** Read the session cookie out of a request's Cookie header. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

/**
 * Build the Set-Cookie header. `Secure` is gated on the request scheme so the
 * cookie still flows over http://localhost in dev; production is https and
 * gets Secure automatically. SameSite=Lax assumes UI and API share a
 * registrable domain (the recommended deployment).
 */
export function sessionSetCookie(cookieValue: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${cookieValue}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function sessionClearCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}
