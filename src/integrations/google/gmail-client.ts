/**
 * Thin Gmail REST wrapper — send a message as the mailbox behind `accessToken`.
 * Plain `fetch`, no SDK. The message is assembled as RFC 2822 MIME, base64url
 * encoded, and posted to users.messages.send. External recipients are fully
 * supported — Gmail draws no internal/external distinction.
 *
 * Phase 2 (inbound read) will add listHistory/getMessage here.
 */

const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

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
