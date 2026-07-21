import type { Env } from "../../env";
import { makeEnvelope, type EventEnvelope } from "../../schemas/envelope";
import { listSyncableAccounts, updateHistoryId } from "./accounts";
import { getAccessToken } from "./tokens";
import {
  getMessage,
  getProfile,
  GmailHistoryGoneError,
  listHistory,
} from "./gmail-client";
import type { GoogleAccount } from "./types";

/**
 * Phase-2 inbound sync — poll every read-scoped connected mailbox and emit an
 * `email.received` event for each newly received message. Bus-events-only: no
 * bodies are carried (Gmail format=metadata), no tickets are auto-created. A
 * consumer that wants more fetches from Gmail using the message id.
 *
 * Runs on the frequent cron (see src/index.ts), mirroring runOverdueSweep: a
 * global system sweep over all tenants. Per-account failures are isolated so
 * one bad mailbox never stalls the others.
 *
 * Checkpointing uses Gmail's historyId. First sight of an account baselines to
 * the current historyId WITHOUT backfilling old mail (only new mail flows). If
 * the stored checkpoint has aged out of Gmail's history window (404), we
 * re-baseline and log the gap rather than crash.
 */

export interface InboxSyncResult {
  accounts: number;
  ingested: number;
  events: EventEnvelope[];
}

/** Only genuinely received mail (in the inbox) — never our own sends/drafts. */
function isReceived(labelIds: string[]): boolean {
  return labelIds.includes("INBOX");
}

async function syncAccount(env: Env, account: GoogleAccount): Promise<EventEnvelope[]> {
  const accessToken = await getAccessToken(env, account);

  // First-ever sync: baseline to "now", do not backfill historical mail.
  if (!account.history_id) {
    const profile = await getProfile(accessToken);
    await updateHistoryId(env.DB, account.tenant_id, account.account_id, profile.historyId);
    return [];
  }

  const local: EventEnvelope[] = [];
  let checkpoint = account.history_id;
  let pageToken: string | undefined;

  try {
    do {
      const page = await listHistory(accessToken, account.history_id, pageToken);
      for (const ref of page.added) {
        const message = await getMessage(accessToken, ref.id);
        if (!isReceived(message.labelIds)) continue;
        local.push(
          makeEnvelope({
            // Deterministic id → the consumer's INSERT OR IGNORE dedupes repeats.
            event_id: `evt_gm_${account.account_id}_${message.id}`,
            event_type: "email.received",
            source_module: "comms",
            tenant_id: account.tenant_id,
            payload: {
              account_id: account.account_id,
              google_email: account.google_email,
              message_id: message.id,
              thread_id: message.threadId,
              from: message.headers["from"],
              to: message.headers["to"],
              subject: message.headers["subject"],
              snippet: message.snippet,
              date: message.headers["date"],
            },
          }),
        );
      }
      if (page.historyId) checkpoint = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (err instanceof GmailHistoryGoneError) {
      // Checkpoint aged out of Gmail's history window — re-baseline and move on.
      const profile = await getProfile(accessToken);
      await updateHistoryId(env.DB, account.tenant_id, account.account_id, profile.historyId);
      console.warn(
        `[google-sync] history gap for ${account.account_id}; re-baselined to ${profile.historyId}`,
      );
      return [];
    }
    throw err;
  }

  // Emit first, THEN advance the checkpoint: if a send fails we re-see the
  // message next run (dedup by event_id makes the repeat harmless), never lose it.
  for (const envelope of local) await env.EVENTS.send(envelope);
  await updateHistoryId(env.DB, account.tenant_id, account.account_id, checkpoint);
  return local;
}

export async function runGoogleInboxSync(env: Env): Promise<InboxSyncResult> {
  // Skip cleanly when Google isn't configured (no key to decrypt tokens with).
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_TOKEN_ENCRYPTION_KEY) {
    return { accounts: 0, ingested: 0, events: [] };
  }

  const accounts = await listSyncableAccounts(env.DB);
  const events: EventEnvelope[] = [];

  for (const account of accounts) {
    try {
      events.push(...(await syncAccount(env, account)));
    } catch (err) {
      // Isolate: one mailbox's failure must not stall the rest of the sweep.
      console.error(`[google-sync] account ${account.account_id} failed: ${String(err)}`);
    }
  }

  return { accounts: accounts.length, ingested: events.length, events };
}
