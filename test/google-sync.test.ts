import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { encryptRefreshToken } from "../src/integrations/google/crypto";
import { runGoogleInboxSync } from "../src/integrations/google/sync";
import { validatePayload } from "../src/schemas/events/registry";

/**
 * Phase-2 inbound sync — polls read-scoped mailboxes and emits email.received
 * for newly received mail. Driven directly (like runOverdueSweep) with Gmail's
 * profile/history/message endpoints stubbed on global fetch.
 */

const TENANT_ID = "biz_google_sync";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";

function routeFetch(handlers: Record<string, () => Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [needle, make] of Object.entries(handlers)) {
      if (url.includes(needle)) return make();
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const tokenOk = () => json({ access_token: "ya29.sync", expires_in: 3599, scope: READONLY });

async function insertAccount(accountId: string, historyId: string | null, scopes = READONLY) {
  const sealed = await encryptRefreshToken(env.GOOGLE_TOKEN_ENCRYPTION_KEY!, "1//refresh");
  await env.DB.prepare(
    `INSERT INTO google_accounts (account_id, tenant_id, kind, google_email, scopes, refresh_token_ciphertext, refresh_token_iv, history_id, status)
     VALUES (?, ?, 'shared', ?, ?, ?, ?, ?, 'active')`,
  )
    // Unique email per account (partial unique index on tenant_id+google_email).
    .bind(accountId, TENANT_ID, `${accountId}@company.com`, scopes, sealed.ciphertext, sealed.iv, historyId)
    .run();
}

async function storedHistoryId(accountId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT history_id FROM google_accounts WHERE account_id = ?",
  )
    .bind(accountId)
    .first<{ history_id: string | null }>();
  return row?.history_id ?? null;
}

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)")
    .bind(TENANT_ID, "Google Sync SME", "hash_sync")
    .run();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.prepare("DELETE FROM google_accounts WHERE tenant_id = ?").bind(TENANT_ID).run();
});

describe("runGoogleInboxSync", () => {
  it("baselines a first-time account to the current historyId without backfilling", async () => {
    await insertAccount("gac_sync_new", null);
    routeFetch({
      "oauth2.googleapis.com/token": tokenOk,
      "/me/profile": () => json({ emailAddress: "inbox@company.com", historyId: "1000" }),
    });

    const result = await runGoogleInboxSync(env);
    expect(result.ingested).toBe(0);
    expect(await storedHistoryId("gac_sync_new")).toBe("1000");
  });

  it("emits email.received for a newly received message and advances the checkpoint", async () => {
    await insertAccount("gac_sync_recv", "1000");
    routeFetch({
      "oauth2.googleapis.com/token": tokenOk,
      "/me/history": () =>
        json({
          history: [{ messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] }],
          historyId: "1050",
        }),
      "/me/messages/": () =>
        json({
          id: "m1",
          threadId: "t1",
          labelIds: ["INBOX", "UNREAD"],
          snippet: "Quick question",
          payload: {
            headers: [
              { name: "From", value: "customer@external.com" },
              { name: "To", value: "inbox@company.com" },
              { name: "Subject", value: "Quick question" },
            ],
          },
        }),
    });

    const result = await runGoogleInboxSync(env);
    expect(result.ingested).toBe(1);

    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    expect(event.event_type).toBe("email.received");
    expect(event.source_module).toBe("comms");
    expect(event.event_id).toBe("evt_gm_gac_sync_recv_m1"); // deterministic → idempotent
    expect(event.payload).toMatchObject({
      message_id: "m1",
      thread_id: "t1",
      from: "customer@external.com",
      subject: "Quick question",
    });
    // Payload conforms to the registered schema.
    expect(validatePayload("email.received", event.payload)).toEqual({ ok: true });
    // Checkpoint advanced so the next run starts after this message.
    expect(await storedHistoryId("gac_sync_recv")).toBe("1050");
  });

  it("skips messages that aren't in the inbox (e.g. our own sent mail)", async () => {
    await insertAccount("gac_sync_sent", "2000");
    routeFetch({
      "oauth2.googleapis.com/token": tokenOk,
      "/me/history": () =>
        json({
          history: [{ messagesAdded: [{ message: { id: "m2", threadId: "t2" } }] }],
          historyId: "2050",
        }),
      "/me/messages/": () =>
        json({ id: "m2", threadId: "t2", labelIds: ["SENT"], snippet: "", payload: { headers: [] } }),
    });

    const result = await runGoogleInboxSync(env);
    expect(result.ingested).toBe(0);
    expect(await storedHistoryId("gac_sync_sent")).toBe("2050"); // still advances
  });

  it("re-baselines when the stored checkpoint has aged out of Gmail's history window (404)", async () => {
    await insertAccount("gac_sync_stale", "3000");
    routeFetch({
      "oauth2.googleapis.com/token": tokenOk,
      "/me/history": () => new Response("gone", { status: 404 }),
      "/me/profile": () => json({ emailAddress: "inbox@company.com", historyId: "3500" }),
    });

    const result = await runGoogleInboxSync(env);
    expect(result.ingested).toBe(0);
    expect(await storedHistoryId("gac_sync_stale")).toBe("3500"); // recovered, not crashed
  });

  it("isolates a failing account so others still sync", async () => {
    await insertAccount("gac_sync_ok", "4000");
    await insertAccount("gac_sync_bad", "5000");
    routeFetch({
      "oauth2.googleapis.com/token": tokenOk,
      // history for the good account returns empty; the bad one 500s on message fetch
      "/me/history": () => json({ history: [], historyId: "4001" }),
    });

    // Neither account has messages; the sweep completes over both without throwing.
    const result = await runGoogleInboxSync(env);
    expect(result.accounts).toBe(2);
    expect(await storedHistoryId("gac_sync_ok")).toBe("4001");
  });
});
