import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { encryptRefreshToken, decryptRefreshToken } from "../src/integrations/google/crypto";

/**
 * Google (Gmail) integration. No real HTTP is made — Google's token, userinfo,
 * and Gmail-send endpoints are asserted against a URL-routed stub of global
 * fetch. Covers the full connect→callback→send lifecycle plus tenant/user
 * isolation and refresh-token encryption at rest.
 */

const TENANT_A = { id: "biz_google_a", key: "test_api_key_google_a" };
const TENANT_B = { id: "biz_google_b", key: "test_api_key_google_b" };

const authFor = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });

const REFRESH_TOKEN = "1//refresh-token-alice";
const GRANTED_SCOPES =
  "https://www.googleapis.com/auth/gmail.send openid https://www.googleapis.com/auth/userinfo.email";

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A fetch stub that dispatches on URL substring and records every call. */
function routeFetch(handlers: Record<string, () => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    for (const [needle, make] of Object.entries(handlers)) {
      if (url.includes(needle)) return make();
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return { mock, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Drive connect → Google → callback and return the created account_id. */
async function connectSharedAccount(
  tenant: typeof TENANT_A,
  opts: { email?: string; refreshToken?: string; scopes?: string } = {},
): Promise<string> {
  const connect = await gatewayFetch("/v1/google-accounts/connect", {
    method: "POST",
    headers: authFor(tenant.key),
    body: JSON.stringify({ kind: "shared", label: "Support inbox" }),
  });
  expect(connect.status).toBe(201);
  const { authorize_url } = (await connect.json()) as { authorize_url: string };
  const state = new URL(authorize_url).searchParams.get("state")!;

  routeFetch({
    "oauth2.googleapis.com/token": () =>
      json({
        access_token: "ya29.access-1",
        refresh_token: opts.refreshToken ?? REFRESH_TOKEN,
        expires_in: 3599,
        scope: opts.scopes ?? GRANTED_SCOPES,
      }),
    "oauth2/v3/userinfo": () =>
      json({ sub: "google-sub-123", email: opts.email ?? "support@company.com" }),
  });

  const callback = await gatewayFetch(`/oauth/google/callback?code=auth_code&state=${state}`);
  expect(callback.status).toBe(200);
  vi.unstubAllGlobals();

  const list = await gatewayFetch("/v1/google-accounts", { headers: authFor(tenant.key) });
  const { google_accounts } = (await list.json()) as { google_accounts: Array<{ account_id: string; google_email: string }> };
  const account = google_accounts.find((a) => a.google_email === (opts.email ?? "support@company.com"))!;
  return account.account_id;
}

beforeAll(async () => {
  for (const t of [TENANT_A, TENANT_B]) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
    )
      .bind(t.id, `Google Test ${t.id}`, await sha256Hex(t.key))
      .run();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refresh-token encryption (crypto.ts)", () => {
  const KEY = env.GOOGLE_TOKEN_ENCRYPTION_KEY!;

  it("round-trips a token and never stores plaintext", async () => {
    const sealed = await encryptRefreshToken(KEY, REFRESH_TOKEN);
    expect(sealed.ciphertext).not.toContain(REFRESH_TOKEN);
    expect(sealed.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(await decryptRefreshToken(KEY, sealed)).toBe(REFRESH_TOKEN);
  });

  it("uses a fresh IV each time (same plaintext → different ciphertext)", async () => {
    const a = await encryptRefreshToken(KEY, REFRESH_TOKEN);
    const b = await encryptRefreshToken(KEY, REFRESH_TOKEN);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });
});

describe("connect", () => {
  it("returns a Google authorize URL carrying the requested scopes and a state nonce", async () => {
    const res = await gatewayFetch("/v1/google-accounts/connect", {
      method: "POST",
      headers: authFor(TENANT_A.key),
      body: JSON.stringify({ kind: "shared", access: "send" }),
    });
    expect(res.status).toBe(201);
    const { authorize_url } = (await res.json()) as { authorize_url: string };
    const url = new URL(authorize_url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://gateway.test/oauth/google/callback",
    );
  });

  it("send_and_read requests the readonly scope too", async () => {
    const res = await gatewayFetch("/v1/google-accounts/connect", {
      method: "POST",
      headers: authFor(TENANT_A.key),
      body: JSON.stringify({ kind: "shared", access: "send_and_read" }),
    });
    const { authorize_url } = (await res.json()) as { authorize_url: string };
    expect(new URL(authorize_url).searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
  });

  it("a 'user' connection cannot be initiated by a programmatic (API-key) caller", async () => {
    const res = await gatewayFetch("/v1/google-accounts/connect", {
      method: "POST",
      headers: authFor(TENANT_A.key),
      body: JSON.stringify({ kind: "user" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("callback", () => {
  it("stores the account with an ENCRYPTED refresh token and the granted scopes", async () => {
    const accountId = await connectSharedAccount(TENANT_A, { email: "enc@company.com" });

    const row = await env.DB.prepare(
      "SELECT refresh_token_ciphertext, refresh_token_iv, scopes, google_sub, status FROM google_accounts WHERE tenant_id = ? AND account_id = ?",
    )
      .bind(TENANT_A.id, accountId)
      .first<{ refresh_token_ciphertext: string; refresh_token_iv: string; scopes: string; google_sub: string; status: string }>();

    expect(row).toBeTruthy();
    // At-rest ciphertext must not be the plaintext token.
    expect(row!.refresh_token_ciphertext).not.toContain(REFRESH_TOKEN);
    // ...and must decrypt back to it.
    const recovered = await decryptRefreshToken(env.GOOGLE_TOKEN_ENCRYPTION_KEY!, {
      ciphertext: row!.refresh_token_ciphertext,
      iv: row!.refresh_token_iv,
    });
    expect(recovered).toBe(REFRESH_TOKEN);
    expect(row!.scopes).toContain("gmail.send");
    expect(row!.google_sub).toBe("google-sub-123");
    expect(row!.status).toBe("active");
  });

  it("rejects an expired/unknown state nonce", async () => {
    const res = await gatewayFetch(`/oauth/google/callback?code=x&state=nonexistent-nonce`);
    expect(res.status).toBe(400);
  });

  it("state is single-use — a replay is rejected", async () => {
    const connect = await gatewayFetch("/v1/google-accounts/connect", {
      method: "POST",
      headers: authFor(TENANT_A.key),
      body: JSON.stringify({ kind: "shared" }),
    });
    const { authorize_url } = (await connect.json()) as { authorize_url: string };
    const state = new URL(authorize_url).searchParams.get("state")!;

    routeFetch({
      "oauth2.googleapis.com/token": () =>
        json({ access_token: "ya29.x", refresh_token: REFRESH_TOKEN, expires_in: 3599, scope: GRANTED_SCOPES }),
      "oauth2/v3/userinfo": () => json({ sub: "s", email: "replay@company.com" }),
    });

    const first = await gatewayFetch(`/oauth/google/callback?code=c&state=${state}`);
    expect(first.status).toBe(200);
    const replay = await gatewayFetch(`/oauth/google/callback?code=c&state=${state}`);
    expect(replay.status).toBe(400); // nonce already consumed
  });
});

describe("send", () => {
  it("sends a Gmail message from the connected mailbox and returns its ids", async () => {
    const accountId = await connectSharedAccount(TENANT_A, { email: "sender@company.com" });

    const { calls } = routeFetch({
      "oauth2.googleapis.com/token": () =>
        json({ access_token: "ya29.send-token", expires_in: 3599, scope: GRANTED_SCOPES }),
      "gmail/v1/users/me/messages/send": () => json({ id: "msg_abc", threadId: "thr_xyz" }),
    });

    const res = await gatewayFetch(`/v1/google-accounts/${accountId}/send`, {
      method: "POST",
      headers: authFor(TENANT_A.key),
      body: JSON.stringify({
        to: ["external@other-company.com"],
        subject: "Hello from CompanyOS",
        body_text: "This is the body.",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivery_ref: string; thread_id: string };
    expect(body.delivery_ref).toBe("msg_abc");
    expect(body.thread_id).toBe("thr_xyz");

    // The Gmail send call carries a bearer token and a raw MIME message that
    // decodes to the expected From/To/Subject and reaches an EXTERNAL recipient.
    const sendCall = calls.find((call) => call.url.includes("messages/send"))!;
    expect((sendCall.init!.headers as Record<string, string>).Authorization).toBe("Bearer ya29.send-token");
    const raw = (JSON.parse(sendCall.init!.body as string) as { raw: string }).raw;
    const mime = new TextDecoder().decode(
      Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)),
    );
    expect(mime).toContain("From: sender@company.com");
    expect(mime).toContain("To: external@other-company.com");
    expect(mime).toContain("Subject: Hello from CompanyOS");
    expect(mime).toContain("This is the body.");
  });

  it("caches the access token — a second send does not refresh again", async () => {
    const accountId = await connectSharedAccount(TENANT_A, { email: "cache@company.com" });
    const { calls } = routeFetch({
      "oauth2.googleapis.com/token": () =>
        json({ access_token: "ya29.cached", expires_in: 3599, scope: GRANTED_SCOPES }),
      "gmail/v1/users/me/messages/send": () => json({ id: "m", threadId: "t" }),
    });

    const send = () =>
      gatewayFetch(`/v1/google-accounts/${accountId}/send`, {
        method: "POST",
        headers: authFor(TENANT_A.key),
        body: JSON.stringify({ to: ["a@b.com"], subject: "s", body_text: "b" }),
      });
    await send();
    await send();

    const refreshCalls = calls.filter((call) => call.url.includes("oauth2.googleapis.com/token"));
    expect(refreshCalls.length).toBe(1); // second send reused the cached token
  });
});

describe("tenant isolation", () => {
  it("tenant B cannot see, send from, or delete tenant A's account", async () => {
    const accountId = await connectSharedAccount(TENANT_A, { email: "isolated@company.com" });

    const list = await gatewayFetch("/v1/google-accounts", { headers: authFor(TENANT_B.key) });
    const { google_accounts } = (await list.json()) as { google_accounts: Array<{ account_id: string }> };
    expect(google_accounts.find((a) => a.account_id === accountId)).toBeUndefined();

    const send = await gatewayFetch(`/v1/google-accounts/${accountId}/send`, {
      method: "POST",
      headers: authFor(TENANT_B.key),
      body: JSON.stringify({ to: ["a@b.com"], subject: "s", body_text: "b" }),
    });
    expect(send.status).toBe(404);

    const del = await gatewayFetch(`/v1/google-accounts/${accountId}`, {
      method: "DELETE",
      headers: authFor(TENANT_B.key),
    });
    expect(del.status).toBe(404);
  });
});

describe("user isolation", () => {
  it("a personal account is invisible and unusable to a programmatic tenant caller", async () => {
    // Insert a kind='user' account owned by a specific human, then act as the
    // tenant API key (system actor) — it must not leak or be usable.
    await env.DB.prepare(
      "INSERT INTO users (user_id, tenant_id, email, role) VALUES (?, ?, ?, ?)",
    )
      .bind("usr_alice", TENANT_A.id, "alice@company.com", "operator")
      .run();
    const sealed = await encryptRefreshToken(env.GOOGLE_TOKEN_ENCRYPTION_KEY!, REFRESH_TOKEN);
    await env.DB.prepare(
      `INSERT INTO google_accounts (account_id, tenant_id, kind, user_id, google_email, scopes, refresh_token_ciphertext, refresh_token_iv)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`,
    )
      .bind(
        "gac_alice_personal",
        TENANT_A.id,
        "usr_alice",
        "alice@company.com",
        "https://www.googleapis.com/auth/gmail.send",
        sealed.ciphertext,
        sealed.iv,
      )
      .run();

    const list = await gatewayFetch("/v1/google-accounts", { headers: authFor(TENANT_A.key) });
    const { google_accounts } = (await list.json()) as { google_accounts: Array<{ account_id: string }> };
    expect(google_accounts.find((a) => a.account_id === "gac_alice_personal")).toBeUndefined();

    const send = await gatewayFetch("/v1/google-accounts/gac_alice_personal/send", {
      method: "POST",
      headers: authFor(TENANT_A.key),
      body: JSON.stringify({ to: ["a@b.com"], subject: "s", body_text: "b" }),
    });
    expect(send.status).toBe(404);
  });
});

describe("revoke", () => {
  it("marks the account revoked; a subsequent send 404s", async () => {
    const accountId = await connectSharedAccount(TENANT_A, { email: "revoke@company.com" });

    // Revoke calls Google's revoke endpoint (best-effort) — stub it.
    routeFetch({ "oauth2.googleapis.com/revoke": () => new Response("", { status: 200 }) });
    const del = await gatewayFetch(`/v1/google-accounts/${accountId}`, {
      method: "DELETE",
      headers: authFor(TENANT_A.key),
    });
    expect(del.status).toBe(200);
    vi.unstubAllGlobals();

    const send = await gatewayFetch(`/v1/google-accounts/${accountId}/send`, {
      method: "POST",
      headers: authFor(TENANT_A.key),
      body: JSON.stringify({ to: ["a@b.com"], subject: "s", body_text: "b" }),
    });
    expect(send.status).toBe(404);
  });
});

describe("configuration gate", () => {
  it("connect fails closed (503) when Google is not configured", async () => {
    const saved = env.GOOGLE_CLIENT_ID;
    delete (env as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID;
    try {
      const res = await gatewayFetch("/v1/google-accounts/connect", {
        method: "POST",
        headers: authFor(TENANT_A.key),
        body: JSON.stringify({ kind: "shared" }),
      });
      expect(res.status).toBe(503);
    } finally {
      (env as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID = saved;
    }
  });
});
