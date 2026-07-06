import { factory as ulidFactory } from "ulid";

/**
 * ulid()'s built-in PRNG auto-detection checks `typeof window`, which is
 * undefined under workerd — it then falls through to a `require("crypto")`
 * path that doesn't behave like Node's, throwing at runtime. Supply an
 * explicit Web Crypto-based PRNG so id generation works in Workers, tests,
 * and Node alike.
 */
export const ulid = ulidFactory(() => {
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] ?? 0) / 0xff;
});
