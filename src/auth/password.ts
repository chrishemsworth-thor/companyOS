/**
 * Password hashing for human users.
 *
 * PBKDF2-HMAC-SHA256 via WebCrypto — workerd has no bcrypt/scrypt/argon2 and a
 * memory-hard hash is awkward inside the Worker CPU budget, but PBKDF2 at ~100k
 * iterations is well within limits and needs no dependency. The iteration count
 * is stored per user (`pwd_iter`) so it can be raised and the hash re-derived on
 * the user's next login without a migration.
 */

const DEFAULT_ITERATIONS = 100_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

export interface PasswordHash {
  hash: string; // hex
  salt: string; // hex
  iterations: number;
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function deriveHex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_BITS,
  );
  return toHex(bits);
}

/** Hash a plaintext password with a fresh random salt. */
export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveHex(password, salt, iterations);
  return { hash, salt: toHex(salt), iterations };
}

/**
 * Verify a plaintext password against a stored hash in constant time
 * (relative to the derived-key comparison — the derivation cost itself is the
 * same regardless of match).
 */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const candidate = await deriveHex(password, fromHex(stored.salt), stored.iterations);
  return timingSafeEqualHex(candidate, stored.hash);
}

/**
 * Constant-time comparison of two hex strings. workerd has no
 * crypto.timingSafeEqual, so accumulate differences with XOR over the full
 * length rather than short-circuiting on the first mismatch.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
