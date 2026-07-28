import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * How the bundle resolves the API origin. A production deploy built WITHOUT
 * VITE_API_BASE_URL silently falls back to http://localhost:8787 — every
 * visitor's own machine — which surfaced only as ERR_CONNECTION_REFUSED behind a
 * generic "could not reach the server". Anyone who had previously typed an
 * origin into the dev-only base-URL field kept working via their localStorage
 * override, so it looked fine to whoever tested the deploy and failed for every
 * new person. These tests pin the three behaviours that matter.
 *
 * The values are read from import.meta.env at module load, so each case stubs
 * the env and re-imports with a fresh module registry.
 */

async function loadAuthModule(apiBaseUrl: string | undefined, hostname: string) {
  vi.resetModules();
  if (apiBaseUrl === undefined) vi.stubEnv("VITE_API_BASE_URL", "");
  else vi.stubEnv("VITE_API_BASE_URL", apiBaseUrl);
  // jsdom's location is read-only; replace just the hostname lookup.
  vi.stubGlobal("location", { ...window.location, hostname });
  return import("./AuthContext");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("API base URL resolution", () => {
  it("pins the configured origin and locks the field when built with the var", async () => {
    const m = await loadAuthModule("https://api.companyos.com.my", "console.companyos.com.my");
    expect(m.DEFAULT_BASE_URL).toBe("https://api.companyos.com.my");
    expect(m.BASE_URL_LOCKED).toBe(true);
    // Correctly built → nothing to warn about.
    expect(m.API_MISCONFIGURED).toBe(false);
  });

  it("strips a trailing slash so request paths don't double up", async () => {
    const m = await loadAuthModule("https://api.companyos.com.my/", "console.companyos.com.my");
    expect(m.DEFAULT_BASE_URL).toBe("https://api.companyos.com.my");
  });

  it("flags a DEPLOYED bundle built without the var (the production incident)", async () => {
    const m = await loadAuthModule(undefined, "console.companyos.com.my");
    expect(m.DEFAULT_BASE_URL).toBe("http://localhost:8787");
    expect(m.BASE_URL_LOCKED).toBe(false);
    // The whole point: a non-local host pointing at localhost is a misconfigured
    // deploy and must be surfaced, not left to fail as a network error.
    expect(m.API_MISCONFIGURED).toBe(true);
  });

  it("does not flag local development, where the localhost default is correct", async () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      const m = await loadAuthModule(undefined, host);
      expect(m.API_MISCONFIGURED).toBe(false);
      expect(m.BASE_URL_LOCKED).toBe(false);
    }
  });
});
