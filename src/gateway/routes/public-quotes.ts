import { Hono, type Context } from "hono";
import type { Env } from "../../env";
import { clientIp, rateLimit } from "../middleware/rate-limit";
import { loadQuoteDocumentInput, sellerNameFor } from "../../modules/quotes/document/load";
import { renderQuoteDocument } from "../../modules/quotes/document/render";
import {
  renderPublicQuotePage,
  renderUnknownLinkPage,
  signPanel,
  type PublicQuoteState,
} from "../../modules/quotes/document/public-page";
import { recordQuoteView, resolveQuoteToken, type ResolvedLink } from "../../modules/quotes/links";
import {
  acceptQuoteViaLink,
  declineQuoteViaLink,
  prefillSignatory,
  readArtifact,
} from "../../modules/quotes/acceptance";
import { currentAgreement } from "../../modules/quotes/agreement";
import { QuotesError } from "../../modules/quotes/service";
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
 * A stored artifact, served as the HTML it is.
 *
 * The CSP is why serving it here is safe where serving it from the generic file
 * route is not: the artifact is self-contained by construction (its images are
 * `data:` URIs), so `default-src 'none'` with inline styles and images allowed
 * renders it exactly and permits nothing else — no script, no fetch, no
 * outbound request of any kind.
 */
function artifactResponse(html: string, sha256: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      // The acceptance record's hash. A client can check what it received
      // against what the record says was signed.
      ETag: `"${sha256}"`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
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

  const state = publicStateFor(resolved.state, resolved.quote.status);
  // The signing panel appears only when a response is actually possible. An
  // "Accept" button on an expired or already-signed quote is worse than no
  // button: it invites a click the server will refuse.
  const agreement = currentAgreement();
  const panel =
    state === "open"
      ? signPanel({
          token: c.req.param("token"),
          agreementText: agreement.text,
          agreementVersion: agreement.version,
          prefill: await prefillSignatory(c.env.DB, resolved.tenant_id, resolved.quote.customer_id),
        })
      : null;

  return publicHtml(
    renderPublicQuotePage({
      document: renderQuoteDocument(input),
      state,
      sellerName: sellerNameFor(input),
      actions: panel?.actions,
      actionStyles: panel?.actionStyles,
    }),
  );
});

/** JSON body of a signing request, kept small — the token carries the rest. */
interface SignBody {
  signatory_name?: unknown;
  signatory_email?: unknown;
  agreed?: unknown;
  signature_data_url?: unknown;
  reason?: unknown;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Shared front half of accept and decline: rate limit, resolve, and turn a
 * `QuotesError` into the JSON the page's script shows the customer.
 *
 * Errors are JSON here rather than HTML because these are called by `fetch`
 * from the page, not by a form post — the page reloads itself on success and
 * shows `error` inline on failure.
 */
async function sign(
  c: Context<{ Bindings: Env }>,
  act: (
    resolved: ResolvedLink,
    body: SignBody,
    context: { ip: string | null; userAgent: string | null },
  ) => Promise<unknown>,
): Promise<Response> {
  const ip = clientIp(c.req.raw);
  if (!(await rateLimit(c.env.SESSIONS, `q:sign:${ip}`, SIGN_LIMIT, HOUR))) {
    return c.json(TOO_MANY, 429);
  }

  const resolved = await resolveQuoteToken(c.env.DB, c.req.param("token") ?? "");
  if (resolved.state === "not_found" || !resolved.quote || !resolved.tenant_id || !resolved.link) {
    if (!(await rateLimit(c.env.SESSIONS, `q:miss:${ip}`, MISS_LIMIT, HOUR))) {
      return c.json(TOO_MANY, 429);
    }
    return c.json({ error: "this link is not valid", code: "not_found" }, 404);
  }

  let body: SignBody;
  try {
    body = (await c.req.json()) as SignBody;
  } catch {
    return c.json({ error: "expected a JSON body", code: "invalid_request" }, 400);
  }

  try {
    const record = await act(resolved, body, {
      ip: ip === "unknown" ? null : ip,
      userAgent: c.req.header("User-Agent") ?? null,
    });
    return c.json(record, 201);
  } catch (err) {
    if (err instanceof QuotesError) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus);
    }
    throw err;
  }
}

/**
 * `POST /q/:token/accept` — click-to-sign.
 *
 * The agreement checkbox is enforced here, not (only) in the page: PRD-004
 * requires acceptance without it to be rejected, and a customer can always send
 * this request by hand.
 */
publicQuotes.post("/:token/accept", (c) =>
  sign(c, (resolved, body, context) =>
    acceptQuoteViaLink(
      c.env,
      resolved,
      {
        signatory_name: str(body.signatory_name, 200),
        signatory_email: str(body.signatory_email, 320),
        // Strictly `true`. A truthy string from a hand-rolled request is not
        // somebody agreeing to anything.
        agreed: body.agreed === true,
        signature_data_url: typeof body.signature_data_url === "string" ? body.signature_data_url : null,
      },
      context,
    ),
  ),
);

/** `POST /q/:token/decline` — the customer says no, with an optional reason. */
publicQuotes.post("/:token/decline", (c) =>
  sign(c, (resolved, body, context) =>
    declineQuoteViaLink(
      c.env,
      resolved,
      {
        signatory_name: str(body.signatory_name, 200),
        signatory_email: str(body.signatory_email, 320),
        reason: str(body.reason, 2000),
      },
      context,
    ),
  ),
);

/**
 * `GET /q/:token/artifact` — what the customer actually signed.
 *
 * Served from storage byte-for-byte, never re-rendered: a re-render would pick
 * up today's branding and today's line items, and the hash in the acceptance
 * record would no longer describe it. The ETag is that hash, so a client can
 * verify what it received against the record.
 */
publicQuotes.get("/:token/artifact", async (c) => {
  const ip = clientIp(c.req.raw);
  if (!(await rateLimit(c.env.SESSIONS, `q:view:${ip}`, VIEW_LIMIT, HOUR))) {
    return c.json(TOO_MANY, 429);
  }

  const resolved = await resolveQuoteToken(c.env.DB, c.req.param("token"));
  if (resolved.state === "not_found" || !resolved.quote || !resolved.tenant_id) {
    if (!(await rateLimit(c.env.SESSIONS, `q:miss:${ip}`, MISS_LIMIT, HOUR))) {
      return c.json(TOO_MANY, 429);
    }
    return unknownLink();
  }

  const artifact = await readArtifact(c.env, resolved.tenant_id, resolved.quote);
  if (!artifact) return unknownLink();
  return artifactResponse(artifact.html, artifact.sha256);
});
