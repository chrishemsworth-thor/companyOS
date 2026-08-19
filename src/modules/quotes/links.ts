import { sha256Hex } from "../../gateway/middleware/auth";
import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { QuotesError, getQuote } from "./service";
import type { Quote } from "./types";

/**
 * Public quote links (PRD-004 P0).
 *
 * A link is a capability: whoever holds the token can read the quote and, while
 * it is `sent`, accept or decline it. So the token follows the same discipline
 * as invites and password resets (`src/auth/tokens.ts`) — 32 random bytes, the
 * raw value returned exactly once at mint, and only `sha256(raw)` stored. A
 * database leak hands over no working links.
 *
 * Resolution is by hash alone because the public route has no tenant to scope
 * to: the token IS the tenant claim, and the row it resolves to is what
 * establishes which tenant's quote is being served.
 */

const TOKEN_BYTES = 32;

/**
 * Statuses a link may be minted from.
 *
 * Not `draft`, and not `pending_approval`. Minting a token for either would
 * publish a document the tenant has not committed to — an unfinished quote, or
 * one whose price an approver has not yet agreed to. PRD-004 puts the sign-off
 * gate before the customer sees anything, and this is where that is enforced.
 */
const LINKABLE_STATUSES: readonly Quote["status"][] = [
  "sent",
  "accepted",
  "rejected",
  "expired",
  "converted",
];

export interface QuoteLink {
  link_id: string;
  quote_id: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Why a token did not resolve to a usable link.
 *
 * `not_found` is the only one that 404s. PRD-004 is explicit that an expired or
 * revoked link renders an explanatory state rather than a 404 — a customer who
 * clicks a stale link in their inbox needs to be told what happened, not shown
 * a dead end.
 */
export type LinkState = "valid" | "expired" | "revoked" | "not_found";

export interface ResolvedLink {
  state: LinkState;
  link: QuoteLink | null;
  tenant_id: string | null;
  quote: Quote | null;
}

const LINK_COLUMNS = "link_id, quote_id, created_by, created_at, expires_at, revoked_at";

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The live (unrevoked) link for a quote, if there is one. */
export async function getActiveLink(
  db: D1Database,
  tenantId: string,
  quoteId: string,
): Promise<QuoteLink | null> {
  return db
    .prepare(
      `SELECT ${LINK_COLUMNS} FROM quote_links
       WHERE tenant_id = ? AND quote_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC, link_id DESC LIMIT 1`,
    )
    .bind(tenantId, quoteId)
    .first<QuoteLink>();
}

/**
 * Mint a public link, returning the raw token for the only time it exists.
 *
 * Minting is idempotent in the way that matters: an existing live link is
 * revoked first, so a quote never has two working tokens. That keeps
 * "revoke the link" a complete action rather than one that has to guess how
 * many are outstanding.
 *
 * Expiry aligns to the quote's own `expiry_date` when it has one — PRD-004's
 * "optional expiry aligned with the quote's own expiry". A quote with no expiry
 * gets a link with none: inventing one would silently break a customer's link
 * on a quote the tenant said was open-ended.
 */
export async function mintQuoteLink(
  db: D1Database,
  tenantId: string,
  quoteId: string,
  createdBy: string | null,
): Promise<{ token: string; link: QuoteLink }> {
  const quote = await getQuote(db, tenantId, quoteId);
  if (!quote) throw new QuotesError("not_found", "quote not found", 404);
  if (!LINKABLE_STATUSES.includes(quote.status)) {
    throw new QuotesError(
      "invalid_status",
      `quote is ${quote.status}: a public link can only be created once it has been sent`,
      409,
    );
  }

  const token = randomHex(TOKEN_BYTES);
  const tokenHash = await sha256Hex(token);
  const linkId = `qlink_${ulid()}`;
  const now = new Date().toISOString();
  // End of the expiry day, so a link is usable throughout the quote's last
  // valid date rather than dying at midnight that morning.
  const expiresAt = quote.expiry_date ? `${quote.expiry_date}T23:59:59.999Z` : null;

  await db.batch([
    db
      .prepare(
        "UPDATE quote_links SET revoked_at = ? WHERE tenant_id = ? AND quote_id = ? AND revoked_at IS NULL",
      )
      .bind(now, tenantId, quoteId),
    db
      .prepare(
        `INSERT INTO quote_links (link_id, tenant_id, quote_id, token_hash, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(linkId, tenantId, quoteId, tokenHash, createdBy, now, expiresAt),
  ]);

  const link = await db
    .prepare(`SELECT ${LINK_COLUMNS} FROM quote_links WHERE tenant_id = ? AND link_id = ?`)
    .bind(tenantId, linkId)
    .first<QuoteLink>();
  return { token, link: link! };
}

/** Revoke the live link for a quote. Revoking when there is none is a 404. */
export async function revokeQuoteLink(
  db: D1Database,
  tenantId: string,
  quoteId: string,
): Promise<void> {
  const link = await getActiveLink(db, tenantId, quoteId);
  if (!link) throw new QuotesError("not_found", "this quote has no active public link", 404);
  await db
    .prepare("UPDATE quote_links SET revoked_at = ? WHERE tenant_id = ? AND link_id = ?")
    .bind(new Date().toISOString(), tenantId, link.link_id)
    .run();
}

/**
 * Resolve a raw token to a link, its tenant and its quote.
 *
 * Never throws and never distinguishes "no such token" from "malformed token":
 * both are `not_found`, and the route renders them identically, so the endpoint
 * leaks nothing to somebody guessing.
 */
export async function resolveQuoteToken(
  db: D1Database,
  token: string,
  now: Date = new Date(),
): Promise<ResolvedLink> {
  const miss: ResolvedLink = { state: "not_found", link: null, tenant_id: null, quote: null };
  // A token is 64 hex characters by construction. Anything else cannot be one,
  // and rejecting it here keeps junk out of the query path.
  if (!/^[0-9a-f]{64}$/.test(token)) return miss;

  const row = await db
    .prepare(
      `SELECT ${LINK_COLUMNS}, tenant_id FROM quote_links WHERE token_hash = ? LIMIT 1`,
    )
    .bind(await sha256Hex(token))
    .first<QuoteLink & { tenant_id: string }>();
  if (!row) return miss;

  const { tenant_id, ...link } = row;
  const quote = await getQuote(db, tenant_id, link.quote_id);
  // A link whose quote has vanished is indistinguishable from a bad token.
  if (!quote) return miss;

  let state: LinkState = "valid";
  if (link.revoked_at) state = "revoked";
  else if (link.expires_at && link.expires_at < now.toISOString()) state = "expired";

  return { state, link, tenant_id, quote };
}

/**
 * Record a public view, emitting `quote.viewed.v1` on the FIRST one only.
 *
 * PRD-004: *"Given a quote viewed twice, then `quote.viewed.v1` fires once
 * (first view), and subsequent views update a `last_viewed_at`."*
 *
 * The "once" is enforced by the database, not by a read-then-write: the
 * conditional `first_viewed_at IS NULL` update either changes a row or it does
 * not, and `meta.changes` is what decides whether the event is emitted. Two
 * simultaneous first views therefore produce exactly one event, which a
 * read-check-write would not guarantee.
 */
export async function recordQuoteView(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  quote: Quote,
  linkId: string,
  context: { ip: string | null; userAgent: string | null },
  now: Date = new Date(),
): Promise<{ firstView: boolean }> {
  const viewedAt = now.toISOString();
  const first = await env.DB.prepare(
    `UPDATE quotes SET first_viewed_at = ?, last_viewed_at = ?, view_count = view_count + 1
     WHERE tenant_id = ? AND quote_id = ? AND first_viewed_at IS NULL`,
  )
    .bind(viewedAt, viewedAt, tenantId, quote.quote_id)
    .run();

  const firstView = (first.meta.changes ?? 0) > 0;
  if (!firstView) {
    await env.DB.prepare(
      `UPDATE quotes SET last_viewed_at = ?, view_count = view_count + 1
       WHERE tenant_id = ? AND quote_id = ?`,
    )
      .bind(viewedAt, tenantId, quote.quote_id)
      .run();
    return { firstView: false };
  }

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "quote.viewed",
      source_module: "sales",
      tenant_id: tenantId,
      occurred_at: viewedAt,
      payload: {
        quote_id: quote.quote_id,
        customer_id: quote.customer_id,
        link_id: linkId,
        viewed_at: viewedAt,
        ...(context.ip ? { ip_address: context.ip } : {}),
        ...(context.userAgent ? { user_agent: context.userAgent } : {}),
      },
    }),
  );
  return { firstView: true };
}
