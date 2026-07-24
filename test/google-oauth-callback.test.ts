import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

/**
 * Security regression: the Google OAuth callback renders an HTML status page
 * that interpolates request-derived values (the `?error=` param, exchange
 * error messages). It must escape them and ship a locked-down CSP so the
 * unauthenticated endpoint can't be turned into a reflected-XSS vector.
 */

async function fetchCallback(query: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://gateway.test/oauth/google/callback${query}`),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("google oauth callback — XSS hardening", () => {
  it("escapes a reflected ?error= payload instead of emitting raw markup", async () => {
    const res = await fetchCallback("?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    const body = await res.text();
    expect(res.headers.get("Content-Type")).toContain("text/html");
    // The raw script tag must never appear; the escaped entities must.
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("sets a restrictive Content-Security-Policy on the callback page", async () => {
    const res = await fetchCallback("?error=access_denied");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
