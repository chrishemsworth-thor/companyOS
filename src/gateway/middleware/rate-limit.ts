/**
 * Best-effort fixed-window rate limiting on Workers KV. KV is eventually
 * consistent across colos, so this is an abuse dampener, not a hard guarantee
 * — production should back it with a Cloudflare WAF rate rule on /v1/auth/*
 * (see docs/production-deployment.md). Uses the existing SESSIONS namespace;
 * counters expire with the window so there is nothing to clean up.
 */
export async function rateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const kvKey = `rl:${key}`;
  const current = Number((await kv.get(kvKey)) ?? "0");
  if (current >= limit) return false;
  // KV requires a TTL of at least 60s; windows below that are rounded up.
  await kv.put(kvKey, String(current + 1), {
    expirationTtl: Math.max(windowSeconds, 60),
  });
  return true;
}

/** Client IP for rate-limit keys: Cloudflare sets CF-Connecting-IP at the edge. */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "unknown";
}
