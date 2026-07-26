import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { sendEmail, DeliveryError } from "../src/delivery/dispatch";
import { encryptRefreshToken } from "../src/integrations/google/crypto";

/**
 * The generalized transactional-email path (sendEmail). Two gating classes:
 * customer-facing purposes keep the delivery_config.enabled opt-in exactly
 * like sendReminder (whose behavior is regression-tested in delivery.test.ts);
 * system purposes (user_invite, password_reset, internal_alert) bypass the
 * opt-in and only need a configured transport. Real HTTP is never made.
 */

const TENANT_ID = "biz_send_email";

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "SendEmail Test SME", "hash_send_email")
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete env.RESEND_API_KEY;
});

function stubFetch(response: Response) {
  const mock = vi.fn(async () => response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function setConfig(input: { enabled: number; from?: string; googleAccountId?: string }) {
  await env.DB.prepare(
    "INSERT INTO delivery_config (tenant_id, channel, from_address, enabled, google_account_id) VALUES (?, 'email', ?, ?, ?)",
  )
    .bind(
      TENANT_ID,
      input.from ?? "billing@sme.example",
      input.enabled,
      input.googleAccountId ?? null,
    )
    .run();
}

/** Seed an active Gmail account with send scope (mirrors google-delivery.test.ts). */
async function insertGoogleAccount(accountId: string) {
  const sealed = await encryptRefreshToken(env.GOOGLE_TOKEN_ENCRYPTION_KEY!, "1//refresh");
  await env.DB.prepare(
    `INSERT INTO google_accounts (account_id, tenant_id, kind, google_email, scopes, refresh_token_ciphertext, refresh_token_iv, status)
     VALUES (?, ?, 'shared', ?, ?, ?, ?, 'active')`,
  )
    .bind(
      accountId,
      TENANT_ID,
      "ops@tenant-domain.example",
      "https://www.googleapis.com/auth/gmail.send",
      sealed.ciphertext,
      sealed.iv,
    )
    .run();
}

/** Stub fetch by URL substring, so Google and Resend can be told apart. */
function routeFetch(handlers: Record<string, () => Response>) {
  const calls: string[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    for (const [needle, make] of Object.entries(handlers)) {
      if (url.includes(needle)) return make();
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return { calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function lastDelivery(to: string) {
  return env.DB.prepare(
    "SELECT purpose, user_id, subject, channel, provider, to_address, status, delivery_ref FROM deliveries WHERE tenant_id = ? AND to_address = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(TENANT_ID, to)
    .first<Record<string, string | null>>();
}

describe("console fallback + audit trail", () => {
  it("no secrets, no config → console, with purpose/user_id/subject logged", async () => {
    const result = await sendEmail(env, TENANT_ID, {
      to: "invitee@example.com",
      subject: "You're invited",
      text: "Come on in.",
      purpose: "user_invite",
      refs: { user_id: "usr_test_1" },
    });
    expect(result.provider).toBe("console");
    expect(result.delivery_ref).toMatch(/^dlv_/);

    const row = await lastDelivery("invitee@example.com");
    expect(row).toMatchObject({
      purpose: "user_invite",
      user_id: "usr_test_1",
      subject: "You're invited",
      channel: "email",
      provider: "console",
      status: "sent",
    });
  });
});

describe("gating classes", () => {
  it("customer purpose + secret but NOT opted in → console, no HTTP", async () => {
    env.RESEND_API_KEY = "re_test_key";
    await setConfig({ enabled: 0 });
    const mock = stubFetch(new Response("{}"));

    const result = await sendEmail(env, TENANT_ID, {
      to: "customer@example.com",
      subject: "Your invoice",
      text: "See attached.",
      purpose: "invoice",
    });
    expect(result.provider).toBe("console");
    expect(mock).not.toHaveBeenCalled();
  });

  it("customer purpose + secret + opted in → resend with the tenant from-address", async () => {
    env.RESEND_API_KEY = "re_test_key";
    await setConfig({ enabled: 1 });
    const mock = stubFetch(new Response(JSON.stringify({ id: "re_msg_1" }), { status: 200 }));

    const result = await sendEmail(env, TENANT_ID, {
      to: "customer@example.com",
      subject: "Your invoice INV-1",
      text: "Amount due: RM 100",
      html: "<p>Amount due: <strong>RM 100</strong></p>",
      purpose: "invoice",
    });
    expect(result).toMatchObject({ provider: "resend", delivery_ref: "re_msg_1" });

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      from: "billing@sme.example",
      to: ["customer@example.com"],
      subject: "Your invoice INV-1",
      text: "Amount due: RM 100",
      html: "<p>Amount due: <strong>RM 100</strong></p>",
    });
  });

  it("system purpose + secret + NO delivery_config → still sends via resend (opt-in bypassed)", async () => {
    env.RESEND_API_KEY = "re_test_key";
    const mock = stubFetch(new Response(JSON.stringify({ id: "re_msg_2" }), { status: 200 }));

    const result = await sendEmail(env, TENANT_ID, {
      to: "staff@example.com",
      subject: "Reset your password",
      text: "Link inside.",
      purpose: "password_reset",
      refs: { user_id: "usr_test_2" },
    });
    expect(result.provider).toBe("resend");

    // With no tenant from-address, system mail falls back to the platform
    // sender identity (SYSTEM_FROM_ADDRESS dev var from wrangler.jsonc).
    const sent = JSON.parse(
      (mock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(sent.from).toBe(env.SYSTEM_FROM_ADDRESS);

    const row = await lastDelivery("staff@example.com");
    expect(row).toMatchObject({ purpose: "password_reset", provider: "resend", status: "sent" });
  });

  it("system purpose ignores the tenant's from_address and uses the platform sender", async () => {
    // Regression: a tenant that configured dunning from its own (unverified
    // in our Resend account) domain must not break invites/resets.
    env.RESEND_API_KEY = "re_test_key";
    await setConfig({ enabled: 1, from: "billing@tenant-domain.example" });
    const mock = stubFetch(new Response(JSON.stringify({ id: "re_msg_4" }), { status: 200 }));

    await sendEmail(env, TENANT_ID, {
      to: "staff3@example.com",
      subject: "You're invited",
      text: "Join us.",
      purpose: "user_invite",
    });

    const sent = JSON.parse(
      (mock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(sent.from).toBe(env.SYSTEM_FROM_ADDRESS);
    expect(sent.from).not.toBe("billing@tenant-domain.example");
  });

  it("system purpose + disabled config → still sends (enabled only gates customer mail)", async () => {
    env.RESEND_API_KEY = "re_test_key";
    await setConfig({ enabled: 0, from: "ops@sme.example" });
    stubFetch(new Response(JSON.stringify({ id: "re_msg_3" }), { status: 200 }));

    const result = await sendEmail(env, TENANT_ID, {
      to: "staff2@example.com",
      subject: "You're invited",
      text: "Join us.",
      purpose: "user_invite",
    });
    expect(result.provider).toBe("resend");
  });
});

describe("tenant Gmail routing", () => {
  it("password_reset NEVER routes through a tenant's Gmail — platform transport only", async () => {
    // A tenant with Gmail connected for its customer mail must not carry
    // account-recovery email: a revoked OAuth grant would break resets.
    env.RESEND_API_KEY = "re_test_key";
    await insertGoogleAccount("gac_send_email");
    await setConfig({ enabled: 1, googleAccountId: "gac_send_email" });
    const { calls } = routeFetch({
      "api.resend.com/emails": () => json({ id: "re_msg_reset" }),
      // Any Gmail/OAuth call would throw "unexpected fetch".
    });

    const result = await sendEmail(env, TENANT_ID, {
      to: "staff@example.com",
      subject: "Reset your password",
      text: "Link inside.",
      purpose: "password_reset",
    });

    expect(result.provider).toBe("resend");
    expect(calls.some((u) => u.includes("googleapis.com"))).toBe(false);
  });

  it("user_invite still rides a connected Gmail (company-domain sender is a feature)", async () => {
    await insertGoogleAccount("gac_send_email2");
    await setConfig({ enabled: 1, googleAccountId: "gac_send_email2" });
    const { calls } = routeFetch({
      "oauth2.googleapis.com/token": () => json({ access_token: "ya29.x", expires_in: 3599, scope: "x" }),
      "gmail/v1/users/me/messages/send": () => json({ id: "gmail_invite", threadId: "thr_1" }),
    });

    const result = await sendEmail(env, TENANT_ID, {
      to: "newhire@example.com",
      subject: "You're invited",
      text: "Join us.",
      purpose: "user_invite",
    });

    expect(result).toMatchObject({ provider: "google", delivery_ref: "gmail_invite" });
    expect(calls.some((u) => u.includes("messages/send"))).toBe(true);
  });
});

describe("failure handling", () => {
  it("provider HTTP failure → DeliveryError(send_failed) and a failed audit row", async () => {
    env.RESEND_API_KEY = "re_test_key";
    stubFetch(new Response("boom", { status: 500 }));

    await expect(
      sendEmail(env, TENANT_ID, {
        to: "unlucky@example.com",
        subject: "Won't arrive",
        text: "…",
        purpose: "user_invite",
      }),
    ).rejects.toThrowError(DeliveryError);

    const row = await lastDelivery("unlucky@example.com");
    expect(row).toMatchObject({ provider: "resend", status: "failed", delivery_ref: null });
  });
});
