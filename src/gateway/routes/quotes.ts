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
import { getCompanyProfile, getQuoteBranding } from "../../modules/quotes/settings";
import { renderQuoteHtml } from "../../modules/quotes/document/render";
import { getContact, getCustomer } from "../../modules/crm/service";

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

export function quotesErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof QuotesError) {
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

quotes.post("/:id/send", async (c) => {
  const tenant = c.get("tenant");
  try {
    return c.json(await sendQuote(c.env, tenant.tenant_id, c.req.param("id")));
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

  const [lines, customer, profile, branding] = await Promise.all([
    getQuoteLines(c.env.DB, tenant.tenant_id, quote.quote_id),
    getCustomer(c.env.DB, tenant.tenant_id, quote.customer_id),
    getCompanyProfile(c.env.DB, tenant.tenant_id),
    getQuoteBranding(c.env.DB, tenant.tenant_id),
  ]);
  if (!customer) return c.json({ error: "customer not found" }, 404);
  const contact = quote.contact_id
    ? await getContact(c.env.DB, tenant.tenant_id, quote.contact_id)
    : null;

  const html = renderQuoteHtml({ quote, lines, customer, contact, profile, branding });
  return c.html(html);
});
