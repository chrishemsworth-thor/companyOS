import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { paginate } from "../../gateway/pagination";
import { createInvoice, type CreateInvoiceInput } from "../finance/service";
import { getQuoteBranding, resolveQuoteDefaultCurrency } from "./settings";
import type { Quote, QuoteLine, QuoteStatus } from "./types";

/**
 * Native Quotes service (source_module: 'sales'). Same shape as finance/crm:
 * validate → one atomic env.DB.batch for the header + lines → emit an event.
 * Totals are computed here and denormalized onto the header (like
 * invoices.total_cents) so lists and the document renderer read one row.
 */

export class QuotesError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_status"
      | "empty_lines"
      | "invalid_total"
      | "contact_mismatch",
    message: string,
    readonly httpStatus: 404 | 409 | 422 = 422,
  ) {
    super(message);
    this.name = "QuotesError";
  }
}

export interface QuoteLineInput {
  item_name: string;
  description?: string;
  note?: string;
  quantity: number;
  unit?: string;
  unit_cents: number;
  discount_cents?: number;
}

export interface CreateQuoteInput {
  customer_id: string;
  contact_id?: string;
  deal_id?: string;
  currency?: string;
  issue_date?: string; // ISO date; defaults to today
  expiry_date?: string; // ISO date
  prepared_by?: string;
  approved_by?: string;
  notes?: string;
  /** Override the per-company configured tax rate (basis points) for this quote. */
  tax_rate_bps?: number;
  lines: QuoteLineInput[];
}

interface ComputedLine extends Required<Omit<QuoteLineInput, "description" | "note" | "unit">> {
  description: string | null;
  note: string | null;
  unit: string | null;
  line_total_cents: number;
}

interface QuoteTotals {
  lines: ComputedLine[];
  subtotal_cents: number;
  discount_total_cents: number;
  tax_rate_bps: number;
  tax_cents: number;
  grand_total_cents: number;
}

/**
 * Compute line totals and the single header tax. Tax is rounded EXACTLY ONCE,
 * on the discounted subtotal — never summed from per-line rounded tax, which is
 * the classic cents-drift bug.
 */
export function computeQuoteTotals(
  lines: QuoteLineInput[],
  taxRateBps: number,
): QuoteTotals {
  const computed: ComputedLine[] = lines.map((l) => {
    const discount = l.discount_cents ?? 0;
    const lineTotal = l.quantity * l.unit_cents - discount;
    if (lineTotal < 0) {
      throw new QuotesError(
        "invalid_total",
        `line "${l.item_name}" discount exceeds its amount`,
      );
    }
    return {
      item_name: l.item_name,
      description: l.description ?? null,
      note: l.note ?? null,
      quantity: l.quantity,
      unit: l.unit ?? null,
      unit_cents: l.unit_cents,
      discount_cents: discount,
      line_total_cents: lineTotal,
    };
  });

  const subtotal = computed.reduce((s, l) => s + l.line_total_cents, 0);
  const discountTotal = computed.reduce((s, l) => s + l.discount_cents, 0);
  const rate = Math.max(0, Math.trunc(taxRateBps));
  const taxCents = rate > 0 ? Math.round((subtotal * rate) / 10_000) : 0;
  return {
    lines: computed,
    subtotal_cents: subtotal,
    discount_total_cents: discountTotal,
    tax_rate_bps: rate,
    tax_cents: taxCents,
    grand_total_cents: subtotal + taxCents,
  };
}

const QUOTE_COLUMNS =
  "quote_id, quote_number, customer_id, contact_id, deal_id, status, currency, issue_date, expiry_date, " +
  "subtotal_cents, discount_total_cents, tax_rate_bps, tax_cents, grand_total_cents, " +
  "prepared_by, approved_by, notes, converted_invoice_id, created_at, updated_at, sent_at, accepted_at";

export async function getQuote(
  db: D1Database,
  tenantId: string,
  quoteId: string,
): Promise<Quote | null> {
  return db
    .prepare(`SELECT ${QUOTE_COLUMNS} FROM quotes WHERE tenant_id = ? AND quote_id = ?`)
    .bind(tenantId, quoteId)
    .first<Quote>();
}

export async function getQuoteLines(
  db: D1Database,
  tenantId: string,
  quoteId: string,
): Promise<QuoteLine[]> {
  const { results } = await db
    .prepare(
      `SELECT line_no, item_name, description, note, quantity, unit, unit_cents, discount_cents, line_total_cents
       FROM quote_lines WHERE tenant_id = ? AND quote_id = ? ORDER BY line_no`,
    )
    .bind(tenantId, quoteId)
    .all<QuoteLine>();
  return results;
}

export async function listQuotes(
  db: D1Database,
  tenantId: string,
  filter: { status?: QuoteStatus; customer_id?: string; cursor?: string; limit: number },
): Promise<{ quotes: Quote[]; next_cursor: string | null }> {
  const clauses = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (filter.status) {
    clauses.push("status = ?");
    binds.push(filter.status);
  }
  if (filter.customer_id) {
    clauses.push("customer_id = ?");
    binds.push(filter.customer_id);
  }
  if (filter.cursor) {
    clauses.push("quote_id > ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT ${QUOTE_COLUMNS} FROM quotes WHERE ${clauses.join(" AND ")}
       ORDER BY quote_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<Quote>();
  const { items, next_cursor } = paginate(results, filter.limit, "quote_id");
  return { quotes: items, next_cursor };
}

/**
 * Mint the next human-friendly quote number for a tenant. Seeds the counter on
 * first use (idempotent, like ensureDefaultStages) then atomically increments,
 * returning the pre-increment value. The UNIQUE (tenant_id, quote_number) index
 * on `quotes` is the collision backstop.
 */
async function nextQuoteNumber(
  db: D1Database,
  tenantId: string,
  year: string,
): Promise<string> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO document_counters (tenant_id, doc_type, next_seq) VALUES (?, 'quote', 1)",
    )
    .bind(tenantId)
    .run();
  const row = await db
    .prepare(
      `UPDATE document_counters SET next_seq = next_seq + 1
       WHERE tenant_id = ? AND doc_type = 'quote'
       RETURNING next_seq - 1 AS seq`,
    )
    .bind(tenantId)
    .first<{ seq: number }>();
  const seq = row?.seq ?? 1;
  return `Q${year}-${String(seq).padStart(4, "0")}`;
}

export async function createQuote(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: CreateQuoteInput,
): Promise<Quote> {
  if (input.lines.length === 0) {
    throw new QuotesError("empty_lines", "a quote needs at least one line");
  }

  const branding = await getQuoteBranding(env.DB, tenantId);
  const cfg = branding.template_config;
  // Explicit request currency > explicitly configured branding currency >
  // company base currency (resolved inside resolveQuoteDefaultCurrency).
  const currency = input.currency ?? (await resolveQuoteDefaultCurrency(env.DB, tenantId));
  const taxRateBps = cfg.show_tax_line ? input.tax_rate_bps ?? cfg.tax_rate_bps : 0;

  const totals = computeQuoteTotals(input.lines, taxRateBps);
  if (totals.grand_total_cents <= 0) {
    throw new QuotesError("invalid_total", "quote total must be positive");
  }

  const issueDate = input.issue_date ?? new Date().toISOString().slice(0, 10);
  const quoteId = `quote_${ulid()}`;
  const quoteNumber = await nextQuoteNumber(env.DB, tenantId, issueDate.slice(0, 4));
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO quotes
         (quote_id, tenant_id, quote_number, customer_id, contact_id, deal_id, status, currency,
          issue_date, expiry_date, subtotal_cents, discount_total_cents, tax_rate_bps, tax_cents,
          grand_total_cents, prepared_by, approved_by, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      quoteId,
      tenantId,
      quoteNumber,
      input.customer_id,
      input.contact_id ?? null,
      input.deal_id ?? null,
      currency,
      issueDate,
      input.expiry_date ?? null,
      totals.subtotal_cents,
      totals.discount_total_cents,
      totals.tax_rate_bps,
      totals.tax_cents,
      totals.grand_total_cents,
      input.prepared_by ?? null,
      input.approved_by ?? null,
      input.notes ?? null,
      now,
      now,
    ),
    ...totals.lines.map((line, i) =>
      env.DB.prepare(
        `INSERT INTO quote_lines
           (quote_id, tenant_id, line_no, item_name, description, note, quantity, unit, unit_cents, discount_cents, line_total_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        quoteId,
        tenantId,
        i + 1,
        line.item_name,
        line.description,
        line.note,
        line.quantity,
        line.unit,
        line.unit_cents,
        line.discount_cents,
        line.line_total_cents,
      ),
    ),
  ]);

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "quote.created",
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        quote_id: quoteId,
        quote_number: quoteNumber,
        customer_id: input.customer_id,
        ...(input.contact_id ? { contact_id: input.contact_id } : {}),
        currency,
        grand_total_cents: totals.grand_total_cents,
      },
    }),
  );

  return (await getQuote(env.DB, tenantId, quoteId))!;
}

/** Shared lifecycle transition: guard the current status, update, emit. */
async function transition(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  quoteId: string,
  opts: {
    from: QuoteStatus[];
    to: QuoteStatus;
    eventType: string;
    stamp?: "sent_at" | "accepted_at";
    extraPayload?: (quote: Quote) => Record<string, unknown>;
  },
): Promise<Quote> {
  const quote = await getQuote(env.DB, tenantId, quoteId);
  if (!quote) throw new QuotesError("not_found", "quote not found", 404);
  if (!opts.from.includes(quote.status)) {
    throw new QuotesError(
      "invalid_status",
      `quote is ${quote.status}, expected ${opts.from.join(" or ")}`,
      409,
    );
  }
  const now = new Date().toISOString();
  const stampSet = opts.stamp ? `, ${opts.stamp} = ?` : "";
  const binds: unknown[] = [opts.to, now];
  if (opts.stamp) binds.push(now);
  binds.push(tenantId, quoteId);
  await env.DB.prepare(
    `UPDATE quotes SET status = ?, updated_at = ?${stampSet} WHERE tenant_id = ? AND quote_id = ?`,
  )
    .bind(...binds)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: opts.eventType,
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        quote_id: quoteId,
        customer_id: quote.customer_id,
        ...(opts.extraPayload ? opts.extraPayload(quote) : {}),
      },
    }),
  );

  return (await getQuote(env.DB, tenantId, quoteId))!;
}

export function sendQuote(env: { DB: D1Database; EVENTS: Queue }, tenantId: string, quoteId: string) {
  return transition(env, tenantId, quoteId, {
    from: ["draft"],
    to: "sent",
    eventType: "quote.sent",
    stamp: "sent_at",
    extraPayload: () => ({ sent_at: new Date().toISOString() }),
  });
}

export function acceptQuote(env: { DB: D1Database; EVENTS: Queue }, tenantId: string, quoteId: string) {
  return transition(env, tenantId, quoteId, {
    from: ["sent"],
    to: "accepted",
    eventType: "quote.accepted",
    stamp: "accepted_at",
    extraPayload: () => ({ accepted_at: new Date().toISOString() }),
  });
}

export function rejectQuote(env: { DB: D1Database; EVENTS: Queue }, tenantId: string, quoteId: string) {
  return transition(env, tenantId, quoteId, {
    from: ["sent"],
    to: "rejected",
    eventType: "quote.rejected",
  });
}

/**
 * Convert an accepted quote into a finance invoice, reusing finance
 * `createInvoice` (which posts the AR/Revenue journal entry atomically). Each
 * quote line maps to an invoice line at {quantity:1, unit_cents: line_total}
 * (net of its discount) plus a synthetic tax line, so the invoice total equals
 * the quote grand total EXACTLY — no re-rounding — and respects the invoice_lines
 * CHECKs (quantity > 0, unit_cents >= 0).
 */
export async function convertQuote(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  quoteId: string,
  opts: { due_date?: string } = {},
): Promise<{ quote: Quote; invoice_id: string }> {
  const quote = await getQuote(env.DB, tenantId, quoteId);
  if (!quote) throw new QuotesError("not_found", "quote not found", 404);
  if (quote.status !== "accepted") {
    throw new QuotesError("invalid_status", `quote is ${quote.status}, expected accepted`, 409);
  }

  const lines = await getQuoteLines(env.DB, tenantId, quoteId);
  const branding = await getQuoteBranding(env.DB, tenantId);

  const invoiceLines: CreateInvoiceInput["lines"] = lines.map((l) => ({
    description: l.description ? `${l.item_name} — ${l.description}` : l.item_name,
    quantity: 1,
    unit_cents: l.line_total_cents,
  }));
  if (quote.tax_cents > 0) {
    invoiceLines.push({
      description: branding.template_config.tax_label,
      quantity: 1,
      unit_cents: quote.tax_cents,
    });
  }

  const dueDate = opts.due_date ?? quote.expiry_date ?? addDays(quote.issue_date, 30);
  const invoice = await createInvoice(env, tenantId, {
    customer_id: quote.customer_id,
    currency: quote.currency,
    due_date: dueDate,
    lines: invoiceLines,
  });

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE quotes SET status = 'converted', converted_invoice_id = ?, updated_at = ?
     WHERE tenant_id = ? AND quote_id = ?`,
  )
    .bind(invoice.invoice_id, now, tenantId, quoteId)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "quote.converted",
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        quote_id: quoteId,
        invoice_id: invoice.invoice_id,
        customer_id: quote.customer_id,
        grand_total_cents: quote.grand_total_cents,
        currency: quote.currency,
      },
    }),
  );

  return { quote: (await getQuote(env.DB, tenantId, quoteId))!, invoice_id: invoice.invoice_id };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
