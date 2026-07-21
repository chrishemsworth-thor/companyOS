/**
 * Reversible encryption for Google refresh tokens at rest (AES-256-GCM via the
 * Workers-native Web Crypto API — no Node crypto). Unlike src/webhooks/verify.ts,
 * which DERIVES a per-source secret with HMAC, Google's opaque refresh token
 * must be recovered byte-for-byte, so this is true reversible encryption.
 *
 * Key: the GOOGLE_TOKEN_ENCRYPTION_KEY secret, 32 random bytes base64-encoded
 * (`head -c 32 /dev/urandom | base64`). Each encryption uses a fresh random
 * 96-bit IV stored alongside the ciphertext. The enc_key_version column on the
 * row lets a future rotation decrypt with the old key and re-encrypt with the
 * new one.
 */

const IV_BYTES = 12; // 96-bit nonce, the AES-GCM standard

export interface SealedToken {
  /** base64 ciphertext (includes the GCM auth tag appended by WebCrypto). */
  ciphertext: string;
  /** base64 96-bit IV. */
  iv: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (base64 of a 256-bit key)");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptRefreshToken(key: string, plaintext: string): Promise<SealedToken> {
  const cryptoKey = await importKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptRefreshToken(key: string, sealed: SealedToken): Promise<string> {
  const cryptoKey = await importKey(key);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(sealed.iv) },
    cryptoKey,
    base64ToBytes(sealed.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}
