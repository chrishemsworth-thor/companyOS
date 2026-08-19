import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { paginate } from "../../gateway/pagination";
import { createInvoice, type CreateInvoiceInput } from "../finance/service";
import { resolvePaymentTermsDays } from "../finance/payment-terms";
import { getQuoteBranding, resolveQuoteDefaultCurrency } from "./settings";
import { requestApproval } from "../approvals/service";
import {
  canTransitionQuote,
  isQuoteEditable,
  type Quote,
  type QuoteLine,
  type QuoteStatus,
} from "./types";

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
      | "contact_mismatch"
      /**
       * The quote has left `draft` and its content is frozen (PRD-004's
       * load-bearing rule). Distinct from `invalid_status`, which is about an
       * illegal lifecycle move: this one is about an edit, and its message
       * names the way forward — create a new version.
       */
      | "locked"
      | "already_superseded"
      /** A malformed acceptance — no name, no email, or the box unticked. */
      | "invalid_request",
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
  "prepared_by, approved_by, notes, converted_invoice_id, created_at, updated_at, sent_at, accepted_at, " +
  "version, supersedes_quote_id, superseded_by_quote_id, " +
  "first_viewed_at, last_viewed_at, view_count, accepted_acceptance_id, " +
  "sign_off_approval_id, sign_off_comment";

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

/**
 * Refuse to mutate a quote that has left `draft`.
 *
 * PRD-004: *"A quote cannot be edited after being sent. Changes require a new
 * version. If the document can change after signing, the signature is
 * worthless — this is the load-bearing requirement of the whole feature."*
 *
 * The message names the way forward rather than just refusing, because the
 * caller virtually always still wants to change something: the answer is
 * `createQuoteVersion`, not "give up". 409 matches the codebase's state-machine
 * convention (src/modules/support/state-machine.ts).
 */
function assertEditable(quote: Quote): void {
  if (!isQuoteEditable(quote.status)) {
    throw new QuotesError(
      "locked",
      `quote ${quote.quote_number} is ${quote.status} and can no longer be edited: ` +
        `create a new version (POST /v1/quotes/${quote.quote_id}/version) to change it`,
      409,
    );
  }
}

export interface UpdateQuoteInput {
  contact_id?: string | null;
  deal_id?: string | null;
  expiry_date?: string | null;
  prepared_by?: string | null;
  approved_by?: string | null;
  notes?: string | null;
  tax_rate_bps?: number;
  /** Full replacement of the line set. Omitted leaves the existing lines alone. */
  lines?: QuoteLineInput[];
}

/** Header fields a PATCH may set, paired with how an omitted key is read. */
const PATCHABLE_FIELDS = [
  "contact_id",
  "deal_id",
  "expiry_date",
  "prepared_by",
  "approved_by",
  "notes",
] as const;

/**
 * Edit a draft quote — the write path PRD-004's immutability rule guards.
 *
 * There was no edit endpoint before S9, which meant there was nothing for
 * *"given a sent quote, when an edit is attempted, then 409"* to fire against.
 * The rule needs a door to lock.
 *
 * Totals are always recomputed from the effective lines and tax rate rather
 * than patched, so a header-only edit cannot leave `grand_total_cents`
 * disagreeing with the lines it is supposed to summarise.
 */
export async function updateQuote(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  quoteId: string,
  input: UpdateQuoteInput,
): Promise<Quote> {
  const quote = await getQuote(env.DB, tenantId, quoteId);
  if (!quote) throw new QuotesError("not_found", "quote not found", 404);
  assertEditable(quote);

  if (input.lines && input.lines.length === 0) {
    throw new QuotesError("empty_lines", "a quote needs at least one line");
  }

  // The effective inputs: what the caller sent, else what is already stored.
  const existingLines = await getQuoteLines(env.DB, tenantId, quoteId);
  const lines: QuoteLineInput[] =
    input.lines ??
    existingLines.map((l) => ({
      item_name: l.item_name,
      description: l.description ?? undefined,
      note: l.note ?? undefined,
      quantity: l.quantity,
      unit: l.unit ?? undefined,
      unit_cents: l.unit_cents,
      discount_cents: l.discount_cents,
    }));
  const totals = computeQuoteTotals(lines, input.tax_rate_bps ?? quote.tax_rate_bps);
  if (totals.grand_total_cents <= 0) {
    throw new QuotesError("invalid_total", "quote total must be positive");
  }

  const now = new Date().toISOString();
  const setFragments: string[] = [];
  const binds: unknown[] = [];
  for (const field of PATCHABLE_FIELDS) {
    if (field in input) {
      setFragments.push(`${field} = ?`);
      binds.push(input[field] ?? null);
    }
  }
  setFragments.push(
    "subtotal_cents = ?",
    "discount_total_cents = ?",
    "tax_rate_bps = ?",
    "tax_cents = ?",
    "grand_total_cents = ?",
    "updated_at = ?",
  );
  binds.push(
    totals.subtotal_cents,
    totals.discount_total_cents,
    totals.tax_rate_bps,
    totals.tax_cents,
    totals.grand_total_cents,
    now,
  );

  const statements = [
    env.DB.prepare(
      `UPDATE quotes SET ${setFragments.join(", ")} WHERE tenant_id = ? AND quote_id = ?`,
    ).bind(...binds, tenantId, quoteId),
  ];

  // Lines are replaced wholesale rather than diffed. Line numbers are positional
  // (PRIMARY KEY (tenant_id, quote_id, line_no)), so a diff would have to
  // renumber anyway, and the delete+insert runs in the same batch as the header
  // update — there is no moment where the header describes a different line set.
  if (input.lines) {
    statements.push(
      env.DB.prepare("DELETE FROM quote_lines WHERE tenant_id = ? AND quote_id = ?").bind(
        tenantId,
        quoteId,
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
    );
  }

  await env.DB.batch(statements);
  return (await getQuote(env.DB, tenantId, quoteId))!;
}

/**
 * Create the next version of a locked quote — PRD-004's answer to "the customer
 * wants a change to a quote we already sent".
 *
 * The new version is a genuinely new quote: its own id, its own number, its own
 * lifecycle, starting at `draft`. The old one is not modified beyond a
 * back-pointer, which is the point — a superseded quote must still render
 * exactly as it did, because somebody may have been shown it.
 *
 * Versioning a `draft` is refused rather than silently allowed: a draft can just
 * be edited, and a tenant accumulating v1..v6 of a quote nobody ever saw is a
 * confusing audit trail, not a useful one.
 */
export async function createQuoteVersion(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  quoteId: string,
): Promise<Quote> {
  const source = await getQuote(env.DB, tenantId, quoteId);
  if (!source) throw new QuotesError("not_found", "quote not found", 404);
  if (source.status === "draft") {
    throw new QuotesError(
      "invalid_status",
      `quote ${source.quote_number} is still a draft and can be edited directly`,
      409,
    );
  }
  if (source.superseded_by_quote_id) {
    throw new QuotesError(
      "already_superseded",
      `quote ${source.quote_number} was already superseded by ${source.superseded_by_quote_id}`,
      409,
    );
  }

  const lines = await getQuoteLines(env.DB, tenantId, quoteId);
  const issueDate = new Date().toISOString().slice(0, 10);
  const newQuoteId = `quote_${ulid()}`;
  const quoteNumber = await nextQuoteNumber(env.DB, tenantId, issueDate.slice(0, 4));
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO quotes
         (quote_id, tenant_id, quote_number, customer_id, contact_id, deal_id, status, currency,
          issue_date, expiry_date, subtotal_cents, discount_total_cents, tax_rate_bps, tax_cents,
          grand_total_cents, prepared_by, approved_by, notes, created_at, updated_at,
          version, supersedes_quote_id)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newQuoteId,
      tenantId,
      quoteNumber,
      source.customer_id,
      source.contact_id,
      source.deal_id,
      source.currency,
      issueDate,
      source.expiry_date,
      source.subtotal_cents,
      source.discount_total_cents,
      source.tax_rate_bps,
      source.tax_cents,
      source.grand_total_cents,
      source.prepared_by,
      source.approved_by,
      source.notes,
      now,
      now,
      source.version + 1,
      source.quote_id,
    ),
    ...lines.map((line) =>
      env.DB.prepare(
        `INSERT INTO quote_lines
           (quote_id, tenant_id, line_no, item_name, description, note, quantity, unit, unit_cents, discount_cents, line_total_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newQuoteId,
        tenantId,
        line.line_no,
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
    // The only change to the superseded quote. Guarded on the column still being
    // NULL so two concurrent version requests cannot both claim the same parent.
    env.DB.prepare(
      `UPDATE quotes SET superseded_by_quote_id = ?, updated_at = ?
       WHERE tenant_id = ? AND quote_id = ? AND superseded_by_quote_id IS NULL`,
    ).bind(newQuoteId, now, tenantId, quoteId),
  ]);

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "quote.created",
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        quote_id: newQuoteId,
        quote_number: quoteNumber,
        customer_id: source.customer_id,
        ...(source.contact_id ? { contact_id: source.contact_id } : {}),
        currency: source.currency,
        grand_total_cents: source.grand_total_cents,
        supersedes_quote_id: source.quote_id,
      },
    }),
  );

  return (await getQuote(env.DB, tenantId, newQuoteId))!;
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
  // `opts.from` is what this particular operation accepts; QUOTE_TRANSITIONS is
  // what the lifecycle allows at all. They are not the same question — sending
  // accepts only `draft` even though `pending_approval` -> `sent` is a legal
  // move (the approval decision makes it, not a second send) — so both are
  // checked. Since 0028 dropped the status CHECK, this table is the only thing
  // standing between a coding slip and an impossible row.
  if (!canTransitionQuote(quote.status, opts.to)) {
    throw new QuotesError(
      "invalid_status",
      `quote cannot move from ${quote.status} to ${opts.to}`,
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

/**
 * Send a quote to the customer — or park it for internal sign-off first.
 *
 * PRD-004 P1: *"Tenant setting: quotes above a value threshold require internal
 * approval before send"* and *"a quote cannot transition to `sent` while an
 * approval is pending"*. So the gate lives HERE, in the one function that can
 * make a quote sendable, rather than in the route: a programmatic caller gets
 * the same gate a human clicking Send does.
 *
 * The comparison is at-or-above the threshold. A tenant setting "approve
 * anything from RM 10,000" means a RM 10,000 quote, not RM 10,000.01.
 *
 * `requestApproval` runs BEFORE the status moves and can legitimately fail with
 * 422 `no_approver`, so a tenant with nobody able to sign off is left holding
 * an editable draft rather than a quote wedged in `pending_approval`. That is
 * the ordering S5 established for claims and it matters more here, because a
 * wedged quote is one nobody can send, edit, or version.
 */
export async function sendQuote(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  quoteId: string,
  actorUserId: string | null = null,
): Promise<Quote> {
  const quote = await getQuote(env.DB, tenantId, quoteId);
  if (!quote) throw new QuotesError("not_found", "quote not found", 404);

  const threshold = (await getQuoteBranding(env.DB, tenantId)).sign_off_threshold_cents;
  const needsSignOff = threshold !== null && quote.grand_total_cents >= threshold;

  if (!needsSignOff) {
    return transition(env, tenantId, quoteId, {
      from: ["draft"],
      to: "sent",
      eventType: "quote.sent",
      stamp: "sent_at",
      extraPayload: () => ({ sent_at: new Date().toISOString() }),
    });
  }

  // Guarded before the approval is raised, so a repeated Send on a quote that
  // is already awaiting sign-off does not stack up approval rows.
  if (quote.status !== "draft") {
    throw new QuotesError(
      "invalid_status",
      `quote is ${quote.status}, expected draft`,
      409,
    );
  }

  const approval = await requestApproval(env, tenantId, {
    subject_type: "quote",
    subject_id: quoteId,
    requested_by: actorUserId,
  });

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE quotes
        SET status = 'pending_approval', sign_off_approval_id = ?, sign_off_comment = NULL, updated_at = ?
      WHERE tenant_id = ? AND quote_id = ? AND status = 'draft'`,
  )
    .bind(approval.approval_id, now, tenantId, quoteId)
    .run();

  // No `quote.*` event here. Nothing has happened to the quote as far as the
  // customer or the ledger is concerned, and `approval.requested` — already
  // emitted by the primitive — is what notifies the approver.
  return (await getQuote(env.DB, tenantId, quoteId))!;
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

  // Only the hardcoded 30-day tail changes with PRD-003: an explicit due date
  // and the quote's own expiry still take precedence, so an accepted quote
  // whose expiry the customer agreed to is not silently re-dated by a terms
  // change. Below that, the customer's payment terms beat a magic number.
  const dueDate =
    opts.due_date ??
    quote.expiry_date ??
    addDays(
      quote.issue_date,
      await resolvePaymentTermsDays(env.DB, tenantId, quote.customer_id),
    );
  const invoice = await createInvoice(env, tenantId, {
    customer_id: quote.customer_id,
    currency: quote.currency,
    due_date: dueDate,
    lines: invoiceLines,
    // PRD-004: the audit trail has to survive conversion. Without this the
    // evidence that anyone agreed to this money stops at the quote, and the
    // invoice — the document that actually gets chased and paid — has no link
    // back to the acceptance that authorised it.
    quote_id: quote.quote_id,
    ...(quote.accepted_acceptance_id
      ? { quote_acceptance_id: quote.accepted_acceptance_id }
      : {}),
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
        ...(quote.accepted_acceptance_id
          ? { acceptance_id: quote.accepted_acceptance_id }
          : {}),
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
