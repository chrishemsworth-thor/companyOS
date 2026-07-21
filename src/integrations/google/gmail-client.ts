/**
 * Thin Gmail REST wrapper — send a message as the mailbox behind `accessToken`.
 * Plain `fetch`, no SDK. The message is assembled as RFC 2822 MIME, base64url
 * encoded, and posted to users.messages.send. External recipients are fully
 * supported — Gmail draws no internal/external distinction.
 *
 * Phase 2 (inbound read) will add listHistory/getMessage here.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const SEND_ENDPOINT = `${GMAIL_BASE}/messages/send`;

export interface GmailSendRequest {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  /** Gmail thread id to attach a reply to an existing conversation. */
  threadId?: string;
}

export interface GmailSendResult {
  id: string;
  threadId: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 2047 encoded-word so non-ASCII subjects survive transport. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = base64Url(new TextEncoder().encode(value))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return `=?UTF-8?B?${b64}?=`;
}

/** Assemble the raw MIME message and base64url-encode it for the Gmail API. */
export function buildRawMessage(req: GmailSendRequest): string {
  const headers: string[] = [
    `From: ${req.from}`,
    `To: ${req.to.join(", ")}`,
  ];
  if (req.cc?.length) headers.push(`Cc: ${req.cc.join(", ")}`);
  headers.push(`Subject: ${encodeHeader(req.subject)}`);
  headers.push("MIME-Version: 1.0");

  let body: string;
  const hasHtml = typeof req.bodyHtml === "string";
  const hasText = typeof req.bodyText === "string";

  if (hasHtml && hasText) {
    const boundary = `bnd_${crypto.randomUUID().replace(/-/g, "")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body =
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n\r\n${req.bodyText}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n\r\n${req.bodyHtml}\r\n` +
      `--${boundary}--`;
  } else if (hasHtml) {
    headers.push(`Content-Type: text/html; charset="UTF-8"`);
    body = req.bodyHtml as string;
  } else {
    headers.push(`Content-Type: text/plain; charset="UTF-8"`);
    body = req.bodyText ?? "";
  }

  const mime = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return base64Url(new TextEncoder().encode(mime));
}

export async function sendGmailMessage(
  accessToken: string,
  req: GmailSendRequest,
): Promise<GmailSendResult> {
  const payload: Record<string, unknown> = { raw: buildRawMessage(req) };
  if (req.threadId) payload.threadId = req.threadId;

  const res = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`gmail send failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; threadId: string };
  return { id: body.id, threadId: body.threadId };
}

// ---------------------------------------------------------------------------
// Inbound read (Phase 2 inbox sync — src/integrations/google/sync.ts)
// ---------------------------------------------------------------------------

/** Thrown when Gmail's history window has rolled past our checkpoint (HTTP 404). */
export class GmailHistoryGoneError extends Error {
  constructor() {
    super("gmail history checkpoint expired (404) — re-baseline required");
    this.name = "GmailHistoryGoneError";
  }
}

async function getJson<T>(accessToken: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) throw new GmailHistoryGoneError();
  if (!res.ok) {
    throw new Error(`gmail GET ${url} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** The mailbox's current historyId — used to baseline a first-time sync. */
export async function getProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  return getJson(accessToken, `${GMAIL_BASE}/profile`);
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface HistoryPage {
  /** Messages added to the mailbox since startHistoryId. */
  added: GmailMessageRef[];
  /** The mailbox historyId as of this response — the next checkpoint. */
  historyId?: string;
  nextPageToken?: string;
}

interface RawHistoryResponse {
  history?: Array<{ messagesAdded?: Array<{ message: GmailMessageRef }> }>;
  historyId?: string;
  nextPageToken?: string;
}

/** One page of message-add history since `startHistoryId`. Throws GmailHistoryGoneError on 404. */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string,
): Promise<HistoryPage> {
  const params = new URLSearchParams({
    startHistoryId,
    historyTypes: "messageAdded",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const raw = await getJson<RawHistoryResponse>(accessToken, `${GMAIL_BASE}/history?${params.toString()}`);
  const added: GmailMessageRef[] = [];
  for (const h of raw.history ?? []) {
    for (const m of h.messagesAdded ?? []) added.push(m.message);
  }
  return { added, historyId: raw.historyId, nextPageToken: raw.nextPageToken };
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  headers: Record<string, string>;
}

interface RawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

/** Fetch a single message's metadata (headers + labels), no body. */
export async function getMessage(accessToken: string, messageId: string): Promise<GmailMessageMeta> {
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "To", "Subject", "Date"]) params.append("metadataHeaders", h);
  const raw = await getJson<RawMessage>(accessToken, `${GMAIL_BASE}/messages/${messageId}?${params.toString()}`);
  const headers: Record<string, string> = {};
  for (const { name, value } of raw.payload?.headers ?? []) headers[name.toLowerCase()] = value;
  return {
    id: raw.id,
    threadId: raw.threadId,
    labelIds: raw.labelIds ?? [],
    snippet: raw.snippet ?? "",
    headers,
  };
}
