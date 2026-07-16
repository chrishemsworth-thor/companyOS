import { timingSafeEqualHex } from "../auth/password";
import type { WebhookProvider } from "./types";

/**
 * Webhook signature material. Per-source secrets are DERIVED, not stored:
 * secret = hex(HMAC-SHA256(WEBHOOK_MASTER_SECRET, source_id)). Provisioning
 * computes it once to show the admin; verification recomputes it per request.
 * GitHub-style HMAC verification needs the raw secret (a stored hash would be
 * useless), and deriving keeps secret material out of D1 entirely — a leaked
 * database cannot forge signatures. Rotation = disable the source and create
 * a new one (new source_id ⇒ new secret).
 */

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function deriveSourceSecret(masterSecret: string, sourceId: string): Promise<string> {
  return hmacSha256Hex(masterSecret, `webhook-source:${sourceId}`);
}

/**
 * Verify a delivery against the source's derived secret, constant-time.
 *
 * - github:    X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of raw body>
 * - bitbucket: X-Hub-Signature:     sha256=<hex HMAC-SHA256 of raw body>
 *              (only present when the hook was created with a secret — setup
 *              docs insist on it; absent header fails verification)
 * - jira:      JIRA Cloud has no native HMAC, so the derived secret rides in
 *              the webhook URL as ?secret=<hex> and is compared directly.
 *              No body integrity — documented limitation.
 */
export async function verifySignature(
  provider: WebhookProvider,
  req: { header: (name: string) => string | undefined; querySecret?: string },
  rawBody: string,
  derivedSecret: string,
): Promise<boolean> {
  if (provider === "jira") {
    const given = req.querySecret ?? "";
    return given.length > 0 && timingSafeEqualHex(given, derivedSecret);
  }
  const headerName = provider === "github" ? "X-Hub-Signature-256" : "X-Hub-Signature";
  const header = req.header(headerName) ?? "";
  if (!header.startsWith("sha256=")) return false;
  const given = header.slice("sha256=".length).toLowerCase();
  const expected = await hmacSha256Hex(derivedSecret, rawBody);
  return timingSafeEqualHex(given, expected);
}
