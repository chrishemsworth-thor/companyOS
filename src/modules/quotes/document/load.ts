import { getContact, getCustomer } from "../../crm/service";
import { getCompanyProfile, getQuoteBranding } from "../settings";
import { getQuoteLines } from "../service";
import type { Quote } from "../types";
import type { RenderQuoteInput } from "./render";

/**
 * Load everything the document renderer needs for one quote.
 *
 * Extracted in S9 because three surfaces now render the same document — the
 * console's `/v1/quotes/:id/document`, the public `/q/:token` page, and the
 * artifact frozen at acceptance — and each assembling its own inputs is exactly
 * how they would come to disagree. The renderer is pure; this is the one place
 * that does the I/O feeding it.
 *
 * Returns null when the quote's customer has gone missing, which the callers
 * turn into a 404 — there is no meaningful document without a buyer on it.
 */
export async function loadQuoteDocumentInput(
  db: D1Database,
  tenantId: string,
  quote: Quote,
): Promise<RenderQuoteInput | null> {
  const [lines, customer, profile, branding] = await Promise.all([
    getQuoteLines(db, tenantId, quote.quote_id),
    getCustomer(db, tenantId, quote.customer_id),
    getCompanyProfile(db, tenantId),
    getQuoteBranding(db, tenantId),
  ]);
  if (!customer) return null;
  const contact = quote.contact_id ? await getContact(db, tenantId, quote.contact_id) : null;
  return { quote, lines, customer, contact, profile, branding };
}

/** The seller name shown to a customer when there is no company profile yet. */
export function sellerNameFor(input: RenderQuoteInput): string {
  return input.profile?.legal_name ?? "Your Company";
}
