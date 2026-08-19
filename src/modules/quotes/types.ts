import { z } from "zod";

/** Quotes module domain types (source_module: 'sales'). Money is integer cents. */

/**
 * The quote lifecycle vocabulary.
 *
 * This is the SOURCE OF TRUTH. `0028_quote_signing.sql` rebuilt `quotes`
 * without a status CHECK — the same trade `0022_roles_drop_check.sql` made for
 * `users.role` — so adding a status is a change here and nowhere else. Every
 * write path goes through the service, which validates against this enum.
 *
 * `pending_approval` is PRD-004's internal sign-off gate: a quote over the
 * tenant's threshold parks here between "send was requested" and "an authorised
 * person agreed", and cannot reach `sent` by any other route.
 */
export const quoteStatusSchema = z.enum([
  "draft",
  "pending_approval",
  "sent",
  "accepted",
  "rejected",
  "expired",
  "converted",
]);

export type QuoteStatus = z.infer<typeof quoteStatusSchema>;

export const QUOTE_STATUSES = quoteStatusSchema.options;

/**
 * Legal moves, in one explicit table so the lifecycle is auditable at a glance
 * — the same shape `src/modules/approvals/service.ts` and the ticket state
 * machine use.
 *
 * `converted` and `rejected` are terminal. `expired` is terminal too: PRD-004
 * requires that an expired quote cannot be accepted, and re-opening one would
 * mean the customer agreeing to pricing the tenant had already withdrawn. The
 * way back is a new version, which is a new row.
 */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ["pending_approval", "sent"],
  // Approval granted sends it; approval rejected returns it to the author.
  pending_approval: ["sent", "draft"],
  sent: ["accepted", "rejected", "expired"],
  accepted: ["converted"],
  rejected: [],
  expired: [],
  converted: [],
};

export function canTransitionQuote(from: QuoteStatus, to: QuoteStatus): boolean {
  return QUOTE_TRANSITIONS[from].includes(to);
}

/**
 * The statuses a quote's own content may still be changed in.
 *
 * PRD-004 calls this "the load-bearing requirement of the whole feature": if the
 * document can change after signing, the signature is worthless. Only `draft`
 * qualifies — a quote awaiting internal sign-off is deliberately frozen too,
 * because otherwise the price an approver agreed to is not the price that goes
 * out.
 */
export const EDITABLE_QUOTE_STATUSES: readonly QuoteStatus[] = ["draft"];

export function isQuoteEditable(status: QuoteStatus): boolean {
  return EDITABLE_QUOTE_STATUSES.includes(status);
}

export interface Quote {
  quote_id: string;
  quote_number: string;
  customer_id: string;
  contact_id: string | null;
  deal_id: string | null;
  status: QuoteStatus;
  currency: string;
  issue_date: string; // ISO date
  expiry_date: string | null;
  subtotal_cents: number;
  discount_total_cents: number;
  tax_rate_bps: number;
  tax_cents: number;
  grand_total_cents: number;
  prepared_by: string | null;
  approved_by: string | null;
  notes: string | null;
  converted_invoice_id: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  accepted_at: string | null;
  /** 1 for an original; n+1 for the quote that replaced version n. */
  version: number;
  /** The quote this one was created from, when it supersedes a locked quote. */
  supersedes_quote_id: string | null;
  /** Set on the older quote when a new version is created from it. */
  superseded_by_quote_id: string | null;
  /** First public view — the one that emitted `quote.viewed.v1`. */
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  /** The `quote_acceptances` row that carried this quote to `accepted`. */
  accepted_acceptance_id: string | null;
  /** The `approvals` row gating `sent`, when the tenant sets a threshold. */
  sign_off_approval_id: string | null;
  /** A rejecting approver's comment, carried back to the draft. */
  sign_off_comment: string | null;
}

export interface QuoteLine {
  line_no: number;
  item_name: string;
  description: string | null;
  note: string | null;
  quantity: number;
  unit: string | null;
  unit_cents: number;
  discount_cents: number;
  line_total_cents: number;
}

/** Seller "From" identity — one row per tenant (migration 0013). */
export interface CompanyProfile {
  legal_name: string;
  reg_no: string | null;
  tax_no: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  default_prepared_by: string | null;
  /** Company-wide default currency for new documents (ISO 4217). */
  base_currency: string;
  /**
   * Company-wide invoice payment terms in days (PRD-003). A customer's own
   * `payment_terms_days` overrides it; NOT NULL, defaulting to 30.
   */
  default_payment_terms_days: number;
}
