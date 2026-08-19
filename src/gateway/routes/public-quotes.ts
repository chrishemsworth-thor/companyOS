import { Hono } from "hono";
import type { Env } from "../../env";
import { clientIp, rateLimit } from "../middleware/rate-limit";
import { loadQuoteDocumentInput, sellerNameFor } from "../../modules/quotes/document/load";
import { renderQuoteDocument } from "../../modules/quotes/document/render";
import {
  renderPublicQuotePage,
  renderUnknownLinkPage,
  type PublicQuoteState,
} from "../../modules/quotes/document/public-page";
import { recordQuoteView, resolveQuoteToken, type ResolvedLink } from "../../modules/quotes/links";
import type { QuoteStatus } from "../../modules/quotes/types";

/**
 * The public quote surface (PRD-004 P0) — `GET /q/:token` and, from phase C,
 * the accept/decline actions.
 *
 * Mounted **outside `/v1`**, alongside `/webhooks`, `/oauth/google` and
 * `/files`: this is the codebase's established position for a caller that
 * carries no credential, and it keeps `authenticate()` a rule with no
 * exceptions rather than a rule with a hole in it. The token is the entire
 * authorization story — it names the quote, and resolving it is what
 * establishes the tenant.
 *
 * ## Rate limiting
 *
 * PRD-004 lists this as an open engineering question: a public endpoint needs
 * abuse protection distinct from the authenticated API's. It reuses
 * `rateLimit()` on the SESSIONS KV namespace — the same best-effort fixed-window
 * dampener `/v1/auth/*` uses, documented as WAF-backed in production — under its
 * own keys and its own, tighter limits.
 *
 * The three limits answer three different abuses, which is why there are three:
 *
 *  - **Views** are the ordinary path. Generous, because a customer refreshing,
 *    forwarding to a colleague and printing is normal behaviour and must not
 *    lock them out of a document they are being asked to sign.
 *  - **Signing** is the expensive path: it renders and archives an artifact.
 *  - **Misses** are the only interesting signal. Enumerating a 32-byte token is
 *    hopeless anyway, but counting only misses throttles a scanner hard without
 *    ever counting against a customer reading their own quote.
 */

export const publicQuotes = new Hono<{ Bindings: Env }>();

const HOUR = 3600;
/** Ordinary reads. A customer may reload, forward and print without penalty. */
const VIEW_LIMIT = 120;
/** Accept/decline. Each one archives an artifact, so it is the costly path. */
export const SIGN_LIMIT = 20;
/** Counted only when a token resolves to nothing — i.e. only for scanners. */
export const MISS_LIMIT = 30;

const TOO_MANY = { error: "too many requests, try again later", code: "rate_limited" } as const;

/** Every miss looks identical, whatever caused it. */
function unknownLink(): Response {
  return new Response(renderUnknownLinkPage(), {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Headers for every public HTML response.
 *
 * `noindex` because a quote is a private commercial document that happens to
 * live behind a guessable-shaped URL; a crawler that finds one in a forwarded
 * email must not put it in a search index. `no-store` because the page's state
 * changes the moment the customer accepts, and a cached "Accept" button on a
 * signed quote is a confusing lie.
 */
function publicHtml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/** The banner state a reader should see, given the link and the quote. */
export function publicStateFor(linkState: ResolvedLink["state"], status: QuoteStatus): PublicQuoteState {
  // The quote's own outcome outranks the link's condition: "you already accepted
  // this" is more useful than "this link expired", and both can be true at once.
  if (status === "accepted") return "accepted";
  if (status === "converted") return "converted";
  if (status === "rejected") return "declined";
  if (status === "expired") return "expired";
  if (linkState === "revoked") return "revoked";
  if (linkState === "expired") return "expired";
  return "open";
}

/**
 * `GET /q/:token` — the customer-facing quote.
 *
 * An unknown token 404s with a body identical to every other miss. An expired
 * or revoked one renders the document with an explanatory banner, per PRD-004:
 * a customer clicking a stale link from their inbox needs to be told what
 * happened, and a 404 tells them nothing.
 */
publicQuotes.get("/:token", async (c) => {
  const ip = clientIp(c.req.raw);
  if (!(await rateLimit(c.env.SESSIONS, `q:view:${ip}`, VIEW_LIMIT, HOUR))) {
    return c.json(TOO_MANY, 429);
  }

  const resolved = await resolveQuoteToken(c.env.DB, c.req.param("token"));
  if (resolved.state === "not_found" || !resolved.quote || !resolved.tenant_id || !resolved.link) {
    if (!(await rateLimit(c.env.SESSIONS, `q:miss:${ip}`, MISS_LIMIT, HOUR))) {
      return c.json(TOO_MANY, 429);
    }
    return unknownLink();
  }

  const input = await loadQuoteDocumentInput(c.env.DB, resolved.tenant_id, resolved.quote);
  // The customer row has gone. There is no document to show and no way to
  // explain that usefully, so it is a miss like any other.
  if (!input) return unknownLink();

  // Recorded before rendering: the evidentiary value of "the customer opened it"
  // does not depend on the page finishing, and a render failure must not lose
  // the fact that it was requested with a valid token.
  await recordQuoteView(c.env, resolved.tenant_id, resolved.quote, resolved.link.link_id, {
    ip: ip === "unknown" ? null : ip,
    userAgent: c.req.header("User-Agent") ?? null,
  });

  return publicHtml(
    renderPublicQuotePage({
      document: renderQuoteDocument(input),
      state: publicStateFor(resolved.state, resolved.quote.status),
      sellerName: sellerNameFor(input),
    }),
  );
});
