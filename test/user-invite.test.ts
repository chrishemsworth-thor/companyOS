import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { issueUserToken, RESET_TTL_SECONDS } from "../src/auth/tokens";

/**
 * User lifecycle — invite + password reset/change. Admins create users
 * WITHOUT a password; the user activates via a single-use invite token and
 * sets their own credential. Forgot/reset reuses the same token machinery.
 * No email transport is configured in tests, so every send hits the console
 * provider and the deliveries audit log.
 */

const API_KEY = "test_api_key_invite";
const TENANT_ID = "biz_invite";
const WORKSPACE = "invite-co";
const ORIGIN = "http://localhost:5173";

const ADMIN = { email: "admin@invite.test", password: "correct horse battery" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function login(email: string, password: string, workspace: string = WORKSPACE) {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace, email, password }),
  });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const body = (await res.json().catch(() => ({}))) as { csrf_token?: string };
  return { status: res.status, cookie, csrf: body.csrf_token };
}

interface InviteBody {
  user: { user_id: string; email: string; status: string };
  invite: { emailed: boolean; provider: string | null; expires_at: string; invite_url: string };
}

/** Create a user as the admin and return the response body. */
async function createInvitedUser(email: string): Promise<{ status: number; body: InviteBody }> {
  const admin = await login(ADMIN.email, ADMIN.password);
  const res = await fetchWorker("/v1/users", {
    method: "POST",
    headers: { Cookie: admin.cookie, "X-CSRF-Token": admin.csrf!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, role: "operator" }),
  });
  return { status: res.status, body: (await res.json()) as InviteBody };
}

function tokenFromUrl(inviteUrl: string): string {
  return new URL(inviteUrl).searchParams.get("token")!;
}

async function acceptInvite(token: string, password: string) {
  const res = await fetchWorker("/v1/auth/invite/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ token, password }),
  });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  return { res, cookie };
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(TENANT_ID, "Invite Tenant", WORKSPACE, await sha256Hex(API_KEY))
    .run();
  await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: ADMIN.email,
    password: ADMIN.password,
    role: "admin",
  });
});

describe("admin creates a user (passwordless invite)", () => {
  it("201s with an invited user, an invite link, and a deliveries audit row", async () => {
    const { status, body } = await createInvitedUser("new@invite.test");
    expect(status).toBe(201);
    expect(body.user.status).toBe("invited");
    // No email transport in tests → console provider → not "emailed".
    expect(body.invite.emailed).toBe(false);
    expect(body.invite.provider).toBe("console");
    expect(body.invite.invite_url).toContain("/accept-invite?token=");
    expect(Date.parse(body.invite.expires_at)).toBeGreaterThan(Date.now());

    const delivery = await env.DB.prepare(
      "SELECT purpose, user_id, channel, provider, to_address, status, subject FROM deliveries WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(TENANT_ID, body.user.user_id)
      .first<Record<string, string>>();
    expect(delivery).toMatchObject({
      purpose: "user_invite",
      channel: "email",
      provider: "console",
      to_address: "new@invite.test",
      status: "sent",
    });
    expect(delivery!.subject).toContain("Invite Tenant");
  });

  it("an invited user cannot log in before accepting", async () => {
    const { body } = await createInvitedUser("pending@invite.test");
    expect(body.user.status).toBe("invited");
    const attempt = await login("pending@invite.test", "anything-at-all");
    expect(attempt.status).toBe(401);
  });
});

describe("invite acceptance", () => {
  it("sets the password, signs the user in, and activates the account", async () => {
    const { body } = await createInvitedUser("accepts@invite.test");
    const token = tokenFromUrl(body.invite.invite_url);

    const { res, cookie } = await acceptInvite(token, "my own password 123");
    expect(res.status).toBe(200);
    expect(cookie).toMatch(/^cos_session=/);
    const accepted = (await res.json()) as { user: { status: string }; csrf_token: string };
    expect(accepted.user.status).toBe("active");
    expect(accepted.csrf_token).toBeTruthy();

    const me = await fetchWorker("/v1/auth/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);

    // And the credential works through the normal login path.
    const relogin = await login("accepts@invite.test", "my own password 123");
    expect(relogin.status).toBe(200);
  });

  it("rejects a second use of the same token (single-use)", async () => {
    const { body } = await createInvitedUser("once@invite.test");
    const token = tokenFromUrl(body.invite.invite_url);

    expect((await acceptInvite(token, "first use password")).res.status).toBe(200);
    const second = await acceptInvite(token, "second use password");
    expect(second.res.status).toBe(400);
    expect(((await second.res.json()) as { code: string }).code).toBe("invalid_token");
  });

  it("rejects an expired token", async () => {
    const { body } = await createInvitedUser("late@invite.test");
    const token = tokenFromUrl(body.invite.invite_url);
    await env.DB.prepare(
      "UPDATE user_tokens SET expires_at = ? WHERE user_id = ? AND used_at IS NULL",
    )
      .bind(new Date(Date.now() - 1000).toISOString(), body.user.user_id)
      .run();

    const { res } = await acceptInvite(token, "too late password");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_token");
  });

  it("rejects garbage tokens", async () => {
    const { res } = await acceptInvite("f".repeat(64), "whatever password");
    expect(res.status).toBe(400);
  });
});

describe("resend invite", () => {
  it("invalidates the old link and issues a fresh one", async () => {
    const { body } = await createInvitedUser("resend@invite.test");
    const oldToken = tokenFromUrl(body.invite.invite_url);

    const admin = await login(ADMIN.email, ADMIN.password);
    const res = await fetchWorker(`/v1/users/${body.user.user_id}/resend-invite`, {
      method: "POST",
      headers: { Cookie: admin.cookie, "X-CSRF-Token": admin.csrf! },
    });
    expect(res.status).toBe(200);
    const { invite } = (await res.json()) as { invite: InviteBody["invite"] };
    const newToken = tokenFromUrl(invite.invite_url);
    expect(newToken).not.toBe(oldToken);

    expect((await acceptInvite(oldToken, "stale link password")).res.status).toBe(400);
    expect((await acceptInvite(newToken, "fresh link password")).res.status).toBe(200);
  });

  it("409s for a user who already has a password", async () => {
    const admin = await login(ADMIN.email, ADMIN.password);
    const adminUser = await env.DB.prepare(
      "SELECT user_id FROM users WHERE tenant_id = ? AND email = ?",
    )
      .bind(TENANT_ID, ADMIN.email)
      .first<{ user_id: string }>();
    const res = await fetchWorker(`/v1/users/${adminUser!.user_id}/resend-invite`, {
      method: "POST",
      headers: { Cookie: admin.cookie, "X-CSRF-Token": admin.csrf! },
    });
    expect(res.status).toBe(409);
  });
});

describe("forgot password", () => {
  async function forgot(workspace: string, email: string, ip = "203.0.113.7") {
    return fetchWorker("/v1/auth/password/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ workspace, email }),
    });
  }

  it("always answers 200, whether or not the account exists", async () => {
    expect((await forgot("no-such-workspace", "nobody@x.test")).status).toBe(200);
    expect((await forgot(WORKSPACE, "nobody@invite.test")).status).toBe(200);
    expect((await forgot(WORKSPACE, ADMIN.email)).status).toBe(200);
  });

  it("creates a reset token and a deliveries row for a real account only", async () => {
    const adminUser = await env.DB.prepare(
      "SELECT user_id FROM users WHERE tenant_id = ? AND email = ?",
    )
      .bind(TENANT_ID, ADMIN.email)
      .first<{ user_id: string }>();

    expect((await forgot(WORKSPACE, ADMIN.email)).status).toBe(200);

    const token = await env.DB.prepare(
      "SELECT purpose FROM user_tokens WHERE user_id = ? AND purpose = 'password_reset' AND used_at IS NULL",
    )
      .bind(adminUser!.user_id)
      .first();
    expect(token).not.toBeNull();

    const delivery = await env.DB.prepare(
      "SELECT purpose, provider, status FROM deliveries WHERE tenant_id = ? AND user_id = ? AND purpose = 'password_reset'",
    )
      .bind(TENANT_ID, adminUser!.user_id)
      .first();
    expect(delivery).toMatchObject({ purpose: "password_reset", provider: "console", status: "sent" });

    // Unknown email produced no token rows for anyone else and no delivery.
    const strayDeliveries = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM deliveries WHERE tenant_id = ? AND to_address = 'nobody@invite.test'",
    )
      .bind(TENANT_ID)
      .first<{ n: number }>();
    expect(strayDeliveries!.n).toBe(0);
  });

  it("silently stops issuing tokens past the per-account limit (still 200)", async () => {
    const adminUser = await env.DB.prepare(
      "SELECT user_id FROM users WHERE tenant_id = ? AND email = ?",
    )
      .bind(TENANT_ID, ADMIN.email)
      .first<{ user_id: string }>();

    for (let i = 0; i < 5; i++) {
      expect((await forgot(WORKSPACE, ADMIN.email)).status).toBe(200);
    }
    // Per-account cap is 3/h: 5 requests leave exactly 3 token rows (older
    // ones are invalidated by each reissue, so count all rows ever created).
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM user_tokens WHERE user_id = ? AND purpose = 'password_reset'",
    )
      .bind(adminUser!.user_id)
      .first<{ n: number }>();
    expect(rows!.n).toBe(3);
  });
});

describe("password reset", () => {
  it("resets the password and revokes every existing session", async () => {
    // An activated user with a live session.
    const { body } = await createInvitedUser("resetme@invite.test");
    await acceptInvite(tokenFromUrl(body.invite.invite_url), "original password");
    const session = await login("resetme@invite.test", "original password");
    expect(session.status).toBe(200);

    // Mint the reset token directly (the raw token normally only exists in
    // the email); the forgot endpoint's token creation is covered above.
    const { raw } = await issueUserToken(env.DB, {
      tenant_id: TENANT_ID,
      user_id: body.user.user_id,
      purpose: "password_reset",
      ttlSeconds: RESET_TTL_SECONDS,
    });

    const res = await fetchWorker("/v1/auth/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: raw, password: "brand new password" }),
    });
    expect(res.status).toBe(200);

    // The pre-reset session is dead, the old password is dead, the new works.
    expect((await fetchWorker("/v1/auth/me", { headers: { Cookie: session.cookie } })).status).toBe(401);
    expect((await login("resetme@invite.test", "original password")).status).toBe(401);
    expect((await login("resetme@invite.test", "brand new password")).status).toBe(200);
  });

  it("rejects reuse of a consumed reset token", async () => {
    const { body } = await createInvitedUser("reuse@invite.test");
    await acceptInvite(tokenFromUrl(body.invite.invite_url), "starting password");
    const { raw } = await issueUserToken(env.DB, {
      tenant_id: TENANT_ID,
      user_id: body.user.user_id,
      purpose: "password_reset",
      ttlSeconds: RESET_TTL_SECONDS,
    });

    const first = await fetchWorker("/v1/auth/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: raw, password: "first reset password" }),
    });
    expect(first.status).toBe(200);

    const second = await fetchWorker("/v1/auth/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: raw, password: "second reset password" }),
    });
    expect(second.status).toBe(400);
  });

  it("an invite token cannot be spent on the reset endpoint (purpose-scoped)", async () => {
    const { body } = await createInvitedUser("crossed@invite.test");
    const inviteToken = tokenFromUrl(body.invite.invite_url);
    const res = await fetchWorker("/v1/auth/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "cross purpose pass" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("password change (logged in)", () => {
  it("requires a session, CSRF, and the correct current password", async () => {
    const { body } = await createInvitedUser("changer@invite.test");
    await acceptInvite(tokenFromUrl(body.invite.invite_url), "current password 1");
    const session = await login("changer@invite.test", "current password 1");

    // No session → 401.
    const anon = await fetchWorker("/v1/auth/password/change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: "current password 1", new_password: "next password 2" }),
    });
    expect(anon.status).toBe(401);

    // Session but no CSRF → 403.
    const noCsrf = await fetchWorker("/v1/auth/password/change", {
      method: "POST",
      headers: { Cookie: session.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: "current password 1", new_password: "next password 2" }),
    });
    expect(noCsrf.status).toBe(403);

    // Wrong current password → 401.
    const wrong = await fetchWorker("/v1/auth/password/change", {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf!, "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: "not my password", new_password: "next password 2" }),
    });
    expect(wrong.status).toBe(401);

    // Correct → 200; new password logs in, session stays valid (not a reset).
    const ok = await fetchWorker("/v1/auth/password/change", {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf!, "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: "current password 1", new_password: "next password 2" }),
    });
    expect(ok.status).toBe(200);
    expect((await fetchWorker("/v1/auth/me", { headers: { Cookie: session.cookie } })).status).toBe(200);
    expect((await login("changer@invite.test", "next password 2")).status).toBe(200);
  });
});
