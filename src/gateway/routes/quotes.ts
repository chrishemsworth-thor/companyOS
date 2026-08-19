import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { IdempotencyConflict, withIdempotency } from "../idempotency";
import { pageQuerySchema } from "../pagination";
import {
  acceptQuote,
  convertQuote,
  createQuote,
  createQuoteVersion,
  getQuote,
  getQuoteLines,
  listQuotes,
  QuotesError,
  rejectQuote,
  sendQuote,
  updateQuote,
} from "../../modules/quotes/service";
import { quoteStatusSchema } from "../../modules/quotes/types";
import { renderQuoteHtml } from "../../modules/quotes/document/render";
import { loadQuoteDocumentInput } from "../../modules/quotes/document/load";
import {
  getActiveLink,
  mintQuoteLink,
  revokeQuoteLink,
} from "../../modules/quotes/links";
import { listAcceptances, readArtifact } from "../../modules/quotes/acceptance";
import { ApprovalsError } from "../../modules/approvals/service";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const listQuerySchema = pageQuerySchema.extend({
  // From the module's own vocabulary rather than a second hand-maintained list:
  // 0028 dropped the SQL CHECK, so a duplicated enum here would be the only
  // place `pending_approval` could go missing.
  status: quoteStatusSchema.optional(),
  customer_id: z.string().optional(),
});

const lineSchema = z.object({
  item_name: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  note: z.string().max(1000).optional(),
  quantity: z.number().int().positive().default(1),
  unit: z.string().max(40).optional(),
  unit_cents: z.number().int().nonnegative(),
  discount_cents: z.number().int().nonnegative().optional(),
});

const createBodySchema = z.object({
  customer_id: z.string().min(1),
  contact_id: z.string().optional(),
  deal_id: z.string().optional(),
  currency: z.string().length(3).optional(),
  issue_date: z.string().regex(ISO_DATE, "issue_date must be YYYY-MM-DD").optional(),
  expiry_date: z.string().regex(ISO_DATE, "expiry_date must be YYYY-MM-DD").optional(),
  prepared_by: z.string().max(200).optional(),
  approved_by: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
  tax_rate_bps: z.number().int().min(0).max(10_000).optional(),
  lines: z.array(lineSchema).min(1),
});

/**
 * PATCH body — every field optional, and every nullable one accepting an
 * explicit `null` so a field can be cleared rather than only overwritten.
 * `lines` replaces the whole set; omitting it leaves the lines alone.
 */
const patchBodySchema = z
  .object({
    contact_id: z.string().nullable().optional(),
    deal_id: z.string().nullable().optional(),
    expiry_date: z
      .string()
      .regex(ISO_DATE, "expiry_date must be YYYY-MM-DD")
      .nullable()
      .optional(),
    prepared_by: z.string().max(200).nullable().optional(),
    approved_by: z.string().max(200).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    tax_rate_bps: z.number().int().min(0).max(10_000).optional(),
    lines: z.array(lineSchema).min(1).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "patch body must set at least one field",
  });

const convertBodySchema = z
  .object({ due_date: z.string().regex(ISO_DATE, "due_date must be YYYY-MM-DD").optional() })
  .optional();

export const quotes = new Hono<AuthedEnv>();

/**
 * The customer-facing URL for a token, built from the request's own origin.
 *
 * Derived rather than configured because the Worker already knows the origin it
 * was reached on, and a mis-set base URL would produce links that resolve to
 * nothing — the one thing a quote link must never do.
 */
function publicQuoteUrl(requestUrl: string, token: string): string {
  return `${new URL(requestUrl).origin}/q/${token}`;
}

export function quotesErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof QuotesError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  // From the send path, which raises an internal sign-off through the approvals
  // primitive (PRD-004 P1). The one that matters is 422 `no_approver`: the
  // tenant set a threshold but has nobody who can act on it. Surfaced with the
  // primitive's own message, which explains exactly that — as a 500 it would
  // look like a server fault rather than a setting to fix.
  if (err instanceof ApprovalsError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

quotes.get("/", zValidator("query", listQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { status, customer_id, cursor, limit } = c.req.valid("query");
  return c.json(await listQuotes(c.env.DB, tenant.tenant_id, { status, customer_id, cursor, limit }));
});

quotes.post("/", zValidator("json", createBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const body = c.req.valid("json");
  try {
    const { status, body: responseBody } = await withIdempotency<unknown>(
      c.env.DB,
      tenant.tenant_id,
      "quotes.create",
      c.req.header("Idempotency-Key"),
      body,
      async () => {
        try {
          const quote = await createQuote(c.env, tenant.tenant_id, body);
          return { status: 201, body: quote };
        } catch (err) {
          if (err instanceof QuotesError) {
            return { status: err.httpStatus, body: { error: err.message, code: err.code } };
          }
          throw err;
        }
      },
    );
    return c.json(responseBody, status);
  } catch (err) {
    if (err instanceof IdempotencyConflict) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus);
    }
    throw err;
  }
});

quotes.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const quote = await getQuote(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!quote) return c.json({ error: "quote not found" }, 404);
  const lines = await getQuoteLines(c.env.DB, tenant.tenant_id, quote.quote_id);
  return c.json({ ...quote, lines });
});

/**
 * `PATCH /v1/quotes/:id` — edit a draft.
 *
 * The counterpart to PRD-004's immutability rule: a quote past `draft` returns
 * 409 with `code: "locked"` and a message naming the version endpoint. Before
 * S9 there was no edit route at all, so there was nothing for that rule to
 * refuse.
 */
quotes.patch("/:id", zValidator("json", patchBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const quote = await updateQuote(c.env, tenant.tenant_id, c.req.param("id"), c.req.valid("json"));
    const lines = await getQuoteLines(c.env.DB, tenant.tenant_id, quote.quote_id);
    return c.json({ ...quote, lines });
  } catch (err) {
    return quotesErrorResponse(c, err);
  }
});

/**
 * `POST /v1/quotes/:id/version` — the sanctioned way to change a locked quote.
 *
 * Returns a new `draft` carrying the same lines, linked both ways to the quote
 * it replaces. The original is untouched apart from its back-pointer.
 */
quotes.post("/:id/version", async (c) => {
  const tenant = c.get("tenant");
  try {
    const quote = await createQuoteVersion(c.env, tenant.tenant_id, c.req.param("id"));
    const lines = await getQuoteLines(c.env.DB, tenant.tenant_id, quote.quote_id);
    return c.json({ ...quote, lines }, 201);
  } catch (err) {
    return quotesErrorResponse(c, err);
  }
});

/**
 * `POST /v1/quotes/:id/send`.
 *
 * Above the tenant's sign-off threshold this returns the quote in
 * `pending_approval` rather than `sent` — the approver decides through the
 * approvals primitive, and approval sends it. See src/modules/quotes/decision.ts.
 */
quotes.post("/:id/send", async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  try {
    return c.json(
      await sendQuote(
        c.env,
        tenant.tenant_id,
        c.req.param("id"),
        actor?.type === "user" ? (actor.id ?? null) : null,
      ),
    );
  } catch (err) {
    return quotesErrorResponse(c, err);
  }
});

quotes.post("/:id/accept", async (c) => {
  const tenant = c.get("tenant");
  try {
    return c.json(await acceptQuote(c.env, tenant.tenant_id, c.req.param("id")));
  } catch (err) {
    return quotesErrorResponse(c, err);
  }
});

quotes.post("/:id/reject", async (c) => {
  const tenant = c.get("tenant");
  try {
    return c.json(await rejectQuote(c.env, tenant.tenant_id, c.req.param("id")));
  } catch (err) {
    return quotesErrorResponse(c, err);
  }
});

quotes.post("/:id/convert", zValidator("json", convertBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const result = await convertQuote(
      c.env,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json") ?? {},
    );
    return c.json(result, 201);
  } catch (err) {
    return quotesErrorResponse(c, err);
  }
});

/** Rendered, per-company-branded quote document (HTML → browser print-to-PDF). */
quotes.get("/:id/document", async (c) => {
  const tenant = c.get("tenant");
  const quote = await getQuote(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!quote) return c.json({ error: "quote not found" }, 404);

  const input = await loadQuoteDocumentInput(c.env.DB, tenant.tenant_id, quote);
  if (!input) return c.json({ error: "customer not found" }, 404);
  return c.html(renderQuoteHtml(input));
});

/**
 * `POST /v1/quotes/:id/link` — mint the customer-facing link.
 *
 * The raw token is in this response and nowhere else, ever: only its SHA-256 is
 * stored. An operator who loses it mints a new one, which revokes the old.
 */
quotes.post("/:id/link", async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  try {
    const { token, link } = await mintQuoteLink(
      c.env.DB,
      tenant.tenant_id,
      c.req.param("id"),
      actor?.type === "user" ? (actor.id ?? null) : null,
    );
    return c.json({ ...link, token, url: publicQuoteUrl(c.req.url, token) }, 201);
  } catch (err) {
    return quotesErrorResponse(c, err);
  }
});

/**
 * `GET /v1/quotes/:id/link` — the live link's metadata.
 *
 * Never the token. It is stored hashed, so this endpoint could not return it
 * even if it wanted to — which is the property that makes a database leak
 * useless against live links.
 */
quotes.get("/:id/link", async (c) => {
  const tenant = c.get("tenant");
  const link = await getActiveLink(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!link) return c.json({ error: "this quote has no active public link" }, 404);
  return c.json(link);
});

/**
 * `GET /v1/quotes/:id/acceptances` — the audit record(s).
 *
 * A list, not a single row, because PRD-004 keeps one row per signatory so that
 * P2 multi-party counter-signing is additive, and because a declined quote that
 * was later re-sent has more than one response worth reading.
 */
quotes.get("/:id/acceptances", async (c) => {
  const tenant = c.get("tenant");
  const quote = await getQuote(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!quote) return c.json({ error: "quote not found" }, 404);
  return c.json({
    acceptances: await listAcceptances(c.env.DB, tenant.tenant_id, quote.quote_id),
    accepted_acceptance_id: quote.accepted_acceptance_id,
  });
});

/**
 * `GET /v1/quotes/:id/artifact` — the frozen document, exactly as signed.
 *
 * Served from storage rather than re-rendered. Re-rendering would silently
 * apply today's branding and today's line items, and the hash on the acceptance
 * record would stop describing what came back — which is the one thing this
 * endpoint exists to make checkable.
 */
quotes.get("/:id/artifact", async (c) => {
  const tenant = c.get("tenant");
  const quote = await getQuote(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!quote) return c.json({ error: "quote not found" }, 404);

  const artifact = await readArtifact(c.env, tenant.tenant_id, quote);
  if (!artifact) {
    return c.json({ error: "this quote has no archived artifact", code: "not_found" }, 404);
  }
  return new Response(artifact.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Self-contained by construction: its images are data: URIs. Nothing else
      // is permitted, so a stored artifact cannot reach out from the API origin.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      ETag: `"${artifact.sha256}"`,
      "Cache-Control": "private, no-store",
    },
  });
});

/** `DELETE /v1/quotes/:id/link` — revoke it. The token stops working at once. */
quotes.delete("/:id/link", async (c) => {
  const tenant = c.get("tenant");
  try {
    await revokeQuoteLink(c.env.DB, tenant.tenant_id, c.req.param("id"));
    return c.body(null, 204);
  } catch (err) {
    return quotesErrorResponse(c, err);
  }
});
