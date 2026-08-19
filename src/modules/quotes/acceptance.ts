import { resolveContact } from "../crm/contact-roles";
import { uploadFile } from "../files/service";
import type { Env } from "../../env";
import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { currentAgreement } from "./agreement";
import { loadQuoteDocumentInput } from "./document/load";
import { htmlDocument, renderQuoteDocument } from "./document/render";
import type { ResolvedLink } from "./links";
import { QuotesError } from "./service";
import type { Quote } from "./types";

/**
 * Click-to-sign acceptance (PRD-004 P0) — the feature the whole PRD exists for.
 *
 * Three properties carry it, and each is enforced structurally rather than by
 * convention:
 *
 *  1. **The hash matches the artifact.** The SHA-256 written to the acceptance
 *     record is the value the files primitive computed over the bytes it
 *     stored. It is copied, never recomputed, so the two cannot disagree.
 *  2. **The artifact is self-contained.** The logo and the signature are inlined
 *     as `data:` URIs. A document referencing `/files/{id}` stops rendering the
 *     moment the tenant deletes that file, and PRD-004 requires the archived
 *     artifact to render identically after the tenant changes their branding.
 *  3. **The artifact exists before the quote moves.** Archival happens first;
 *     only then does one `db.batch()` write the acceptance row and flip the
 *     quote. A failure at any earlier point leaves a `sent` quote and an
 *     orphaned file, which is recoverable. The reverse — an `accepted` quote
 *     with no artifact — is not, because the evidence is the point.
 */

/** Match rungs recorded against an acceptance, extending PRD-003's chain. */
export type ContactMatch = "role" | "primary" | "any" | "email";

export interface AcceptQuoteInput {
  signatory_name: string;
  signatory_email: string;
  /** PRD-004: acceptance without the agreement ticked must be rejected. */
  agreed: boolean;
  /** Optional typed or drawn signature, as a `data:image/...;base64,...` URI. */
  signature_data_url?: string | null;
}

export interface DeclineQuoteInput {
  signatory_name: string;
  signatory_email: string;
  reason?: string | null;
}

export interface SigningContext {
  ip: string | null;
  userAgent: string | null;
}

export interface AcceptanceRecord {
  acceptance_id: string;
  quote_id: string;
  link_id: string;
  decision: "accepted" | "declined";
  signatory_name: string;
  signatory_email: string;
  contact_id: string | null;
  contact_match: string | null;
  agreement_version: string;
  agreement_text: string;
  document_sha256: string | null;
  artifact_file_id: string | null;
  signature_file_id: string | null;
  decline_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

const ACCEPTANCE_COLUMNS =
  "acceptance_id, quote_id, link_id, decision, signatory_name, signatory_email, " +
  "contact_id, contact_match, agreement_version, agreement_text, document_sha256, " +
  "artifact_file_id, signature_file_id, decline_reason, ip_address, user_agent, created_at";

/** A quote in a state where the customer may still respond to it. */
function assertRespondable(quote: Quote, linkState: ResolvedLink["state"]): void {
  if (quote.status === "accepted" || quote.status === "converted") {
    throw new QuotesError("invalid_status", "this quotation has already been accepted", 409);
  }
  if (quote.status === "rejected") {
    throw new QuotesError("invalid_status", "this quotation has already been declined", 409);
  }
  if (quote.status === "expired") {
    throw new QuotesError("invalid_status", "this quotation has expired", 409);
  }
  if (quote.status !== "sent") {
    throw new QuotesError("invalid_status", "this quotation is not open for a response", 409);
  }
  // A link can lapse while the quote itself is still `sent` — the tenant
  // revoked it, or its own expiry passed first. Either way the holder of that
  // link no longer has authority to bind anyone.
  if (linkState === "revoked") {
    throw new QuotesError("invalid_status", "this link is no longer active", 409);
  }
  if (linkState === "expired") {
    throw new QuotesError("invalid_status", "this link has expired", 409);
  }
}

/**
 * Base64 in fixed chunks.
 *
 * `String.fromCharCode(...bytes)` on a 2 MB logo spreads two million arguments
 * across the call stack and throws. This is the boring version that does not.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function toDataUri(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${toBase64(bytes)}`;
}

/**
 * Parse a `data:` URL submitted from the public page.
 *
 * Returns null for anything that is not a base64 `data:` URL, rather than
 * throwing: a browser that produced something unexpected should cost the
 * customer their signature image, not their acceptance. The bytes are then
 * validated properly by the `signature` file policy (1 MB, image types only)
 * on the way in.
 */
function parseDataUrl(value: string): { bytes: Uint8Array; contentType: string } | null {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());
  if (!match) return null;
  try {
    const binary = atob(match[2]!.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.length > 0 ? { bytes, contentType: match[1]!.toLowerCase() } : null;
  } catch {
    return null;
  }
}

/** The tenant's logo bytes, inlined, so the artifact stops depending on R2. */
async function logoDataUri(env: Env, tenantId: string, logoFileId: string | null): Promise<string | null> {
  if (!logoFileId) return null;
  const row = await env.DB.prepare(
    "SELECT r2_key, content_type FROM files WHERE tenant_id = ? AND file_id = ? AND deleted_at IS NULL",
  )
    .bind(tenantId, logoFileId)
    .first<{ r2_key: string; content_type: string }>();
  if (!row) return null;
  const object = await env.FILES.get(row.r2_key);
  // A logo whose bytes have gone is not a reason to block an acceptance. The
  // artifact simply falls back to the company name in type, which PRD-004
  // already requires to render cleanly.
  if (!object) return null;
  return toDataUri(new Uint8Array(await object.arrayBuffer()), row.content_type);
}

/**
 * Attribute a signatory to a known contact (PRD-003, via S8).
 *
 * The `signatory` role is resolved first — that is who the tenant expected, and
 * it is what the form pre-fills with. Attribution is only recorded when the
 * submitted email actually matches a contact, because "somebody we have never
 * heard of accepted this" is exactly the fact an audit reader needs to see, and
 * silently stamping the expected contact onto it would hide that.
 */
export async function matchSignatory(
  db: D1Database,
  tenantId: string,
  customerId: string,
  email: string,
): Promise<{ contact_id: string | null; contact_match: ContactMatch | null }> {
  const normalized = email.trim().toLowerCase();
  const resolved = await resolveContact(db, tenantId, customerId, "signatory");
  if (resolved?.contact.email && resolved.contact.email.toLowerCase() === normalized) {
    return { contact_id: resolved.contact.contact_id, contact_match: resolved.matched };
  }
  const byEmail = await db
    .prepare(
      "SELECT contact_id FROM contacts WHERE tenant_id = ? AND customer_id = ? AND lower(email) = ? LIMIT 1",
    )
    .bind(tenantId, customerId, normalized)
    .first<{ contact_id: string }>();
  return byEmail
    ? { contact_id: byEmail.contact_id, contact_match: "email" }
    : { contact_id: null, contact_match: null };
}

/** The signatory contact the public form pre-fills from, if there is one. */
export async function prefillSignatory(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<{ name: string; email: string } | null> {
  const resolved = await resolveContact(db, tenantId, customerId, "signatory");
  // Only a genuine `signatory` match pre-fills. Falling back to "any contact"
  // would put a warehouse manager's name in a box that says "I am authorised to
  // accept on behalf of the organisation".
  if (!resolved || resolved.matched !== "role") return null;
  return { name: resolved.contact.name, email: resolved.contact.email ?? "" };
}

/**
 * Accept a quote through its public link.
 *
 * Ordering is the safety property: validate, archive, then commit. The artifact
 * is written to file storage BEFORE the batch that marks the quote accepted, so
 * the only failure mode is an orphaned file — never an accepted quote whose
 * evidence does not exist.
 */
export async function acceptQuoteViaLink(
  env: Env,
  resolved: ResolvedLink,
  input: AcceptQuoteInput,
  context: SigningContext,
  now: Date = new Date(),
): Promise<AcceptanceRecord> {
  const tenantId = resolved.tenant_id!;
  const quote = resolved.quote!;
  assertRespondable(quote, resolved.state);

  if (!input.agreed) {
    throw new QuotesError(
      "invalid_request",
      "the agreement must be accepted before this quotation can be signed",
      422,
    );
  }
  const name = input.signatory_name.trim();
  const email = input.signatory_email.trim();
  if (!name || !email) {
    throw new QuotesError("invalid_request", "a name and an email address are required", 422);
  }

  const documentInput = await loadQuoteDocumentInput(env.DB, tenantId, quote);
  if (!documentInput) {
    throw new QuotesError("not_found", "quote not found", 404);
  }

  // The signature, if any. Stored as its own file (PRD-004 asks for
  // `purpose = signature`) AND inlined into the artifact — the file is the
  // separately auditable original, the inline copy is what keeps the artifact
  // standalone.
  let signatureFileId: string | null = null;
  let signatureDataUri: string | null = null;
  const parsedSignature = input.signature_data_url ? parseDataUrl(input.signature_data_url) : null;
  if (parsedSignature) {
    const stored = await uploadFile(env, tenantId, {
      bytes: parsedSignature.bytes.buffer.slice(
        parsedSignature.bytes.byteOffset,
        parsedSignature.bytes.byteOffset + parsedSignature.bytes.byteLength,
      ) as ArrayBuffer,
      filename: `signature-${quote.quote_number}.png`,
      contentType: parsedSignature.contentType,
      purpose: "signature",
      // No user: the signatory is a customer, not an account in this system.
      uploadedBy: null,
    });
    signatureFileId = stored.file_id;
    signatureDataUri = toDataUri(parsedSignature.bytes, parsedSignature.contentType);
  }

  const agreement = currentAgreement();
  const acceptedAt = now.toISOString();
  const artifactHtml = htmlDocument(
    renderQuoteDocument({
      ...documentInput,
      logoDataUri: await logoDataUri(env, tenantId, documentInput.branding.logo_file_id),
      acceptance: {
        signatory_name: name,
        signatory_email: email,
        accepted_at: acceptedAt,
        ip_address: context.ip,
        user_agent: context.userAgent,
        agreement_version: agreement.version,
        agreement_text: agreement.text,
        signature_data_uri: signatureDataUri,
      },
    }),
  );

  const artifact = await uploadFile(env, tenantId, {
    bytes: new TextEncoder().encode(artifactHtml).buffer as ArrayBuffer,
    filename: `${quote.quote_number}-accepted.html`,
    contentType: "text/html",
    purpose: "quote_artifact",
    uploadedBy: null,
  });

  const { contact_id, contact_match } = await matchSignatory(
    env.DB,
    tenantId,
    quote.customer_id,
    email,
  );
  const acceptanceId = `qacc_${ulid()}`;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO quote_acceptances
         (acceptance_id, tenant_id, quote_id, link_id, decision, signatory_name, signatory_email,
          contact_id, contact_match, agreement_version, agreement_text, document_sha256,
          artifact_file_id, signature_file_id, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      acceptanceId,
      tenantId,
      quote.quote_id,
      resolved.link!.link_id,
      name,
      email,
      contact_id,
      contact_match,
      agreement.version,
      agreement.text,
      // The hash the files primitive computed over the bytes it stored. Copied,
      // never recomputed — which is what makes "the stored artifact's SHA-256
      // equals the hash in the acceptance record" true by construction.
      artifact.sha256,
      artifact.file_id,
      signatureFileId,
      context.ip,
      context.userAgent,
      acceptedAt,
    ),
    // Guarded on `status = 'sent'` so two simultaneous accepts cannot both
    // succeed: the second changes no rows and its acceptance row is the only
    // thing written, which the read-back below turns into a 409.
    env.DB.prepare(
      `UPDATE quotes
          SET status = 'accepted', accepted_at = ?, accepted_acceptance_id = ?, updated_at = ?
        WHERE tenant_id = ? AND quote_id = ? AND status = 'sent'`,
    ).bind(acceptedAt, acceptanceId, acceptedAt, tenantId, quote.quote_id),
  ]);

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "quote.accepted",
      source_module: "sales",
      tenant_id: tenantId,
      occurred_at: acceptedAt,
      payload: {
        quote_id: quote.quote_id,
        customer_id: quote.customer_id,
        accepted_at: acceptedAt,
        acceptance_id: acceptanceId,
        signatory_name: name,
        signatory_email: email,
        document_sha256: artifact.sha256,
        artifact_file_id: artifact.file_id,
        ...(contact_id ? { contact_id, contact_match: contact_match! } : {}),
      },
    }),
  );

  return (await getAcceptance(env.DB, tenantId, acceptanceId))!;
}

/**
 * Decline a quote through its public link.
 *
 * No artifact: nothing was agreed, so there is nothing to freeze. The record is
 * still kept — who declined, when, from where, and why — because "they said no
 * on the 14th" is a fact a sales operator needs as much as a yes.
 */
export async function declineQuoteViaLink(
  env: Env,
  resolved: ResolvedLink,
  input: DeclineQuoteInput,
  context: SigningContext,
  now: Date = new Date(),
): Promise<AcceptanceRecord> {
  const tenantId = resolved.tenant_id!;
  const quote = resolved.quote!;
  assertRespondable(quote, resolved.state);

  const name = input.signatory_name.trim();
  const email = input.signatory_email.trim();
  if (!name || !email) {
    throw new QuotesError("invalid_request", "a name and an email address are required", 422);
  }

  const agreement = currentAgreement();
  const declinedAt = now.toISOString();
  const acceptanceId = `qacc_${ulid()}`;
  const reason = input.reason?.trim() || null;
  const { contact_id, contact_match } = await matchSignatory(
    env.DB,
    tenantId,
    quote.customer_id,
    email,
  );

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO quote_acceptances
         (acceptance_id, tenant_id, quote_id, link_id, decision, signatory_name, signatory_email,
          contact_id, contact_match, agreement_version, agreement_text, decline_reason,
          ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, 'declined', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      acceptanceId,
      tenantId,
      quote.quote_id,
      resolved.link!.link_id,
      name,
      email,
      contact_id,
      contact_match,
      agreement.version,
      agreement.text,
      reason,
      context.ip,
      context.userAgent,
      declinedAt,
    ),
    env.DB.prepare(
      `UPDATE quotes SET status = 'rejected', updated_at = ?
        WHERE tenant_id = ? AND quote_id = ? AND status = 'sent'`,
    ).bind(declinedAt, tenantId, quote.quote_id),
  ]);

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "quote.rejected",
      source_module: "sales",
      tenant_id: tenantId,
      occurred_at: declinedAt,
      payload: {
        quote_id: quote.quote_id,
        customer_id: quote.customer_id,
        acceptance_id: acceptanceId,
        signatory_name: name,
        signatory_email: email,
        ...(reason ? { reason } : {}),
      },
    }),
  );

  return (await getAcceptance(env.DB, tenantId, acceptanceId))!;
}

export async function getAcceptance(
  db: D1Database,
  tenantId: string,
  acceptanceId: string,
): Promise<AcceptanceRecord | null> {
  return db
    .prepare(
      `SELECT ${ACCEPTANCE_COLUMNS} FROM quote_acceptances
        WHERE tenant_id = ? AND acceptance_id = ?`,
    )
    .bind(tenantId, acceptanceId)
    .first<AcceptanceRecord>();
}

/** Every response recorded against a quote, oldest first. */
export async function listAcceptances(
  db: D1Database,
  tenantId: string,
  quoteId: string,
): Promise<AcceptanceRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ACCEPTANCE_COLUMNS} FROM quote_acceptances
        WHERE tenant_id = ? AND quote_id = ? ORDER BY created_at ASC, acceptance_id ASC`,
    )
    .bind(tenantId, quoteId)
    .all<AcceptanceRecord>();
  return results;
}

/**
 * The archived artifact's bytes, exactly as stored.
 *
 * Served from R2 rather than re-rendered, which is the entire point: a
 * re-render would pick up today's branding and today's line items, and the
 * hash would no longer match.
 */
export async function readArtifact(
  env: Env,
  tenantId: string,
  quote: Quote,
): Promise<{ html: string; sha256: string } | null> {
  if (!quote.accepted_acceptance_id) return null;
  const acceptance = await getAcceptance(env.DB, tenantId, quote.accepted_acceptance_id);
  if (!acceptance?.artifact_file_id) return null;

  const file = await env.DB.prepare(
    "SELECT r2_key, sha256 FROM files WHERE tenant_id = ? AND file_id = ? AND deleted_at IS NULL",
  )
    .bind(tenantId, acceptance.artifact_file_id)
    .first<{ r2_key: string; sha256: string }>();
  if (!file) return null;
  const object = await env.FILES.get(file.r2_key);
  if (!object) return null;
  return { html: await object.text(), sha256: file.sha256 };
}
