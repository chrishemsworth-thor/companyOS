import { z } from "zod";

/**
 * quote.accepted.v1 — the customer accepted the quote.
 *
 * S9 (PRD-004) added the click-to-sign fields. They are OPTIONAL and this is a
 * non-strict object, so every existing emitter and consumer keeps working and
 * no v2 is needed — the same additive treatment S8 gave
 * `collections.decision.v1`. They are optional rather than required because the
 * operator-side `POST /v1/quotes/:id/accept` still exists: a rep who took the
 * yes over the phone records it there, and that acceptance genuinely has no
 * signatory, no artifact and no hash.
 */
export const quoteAcceptedV1 = z.object({
  quote_id: z.string(),
  customer_id: z.string(),
  accepted_at: z.string().datetime(),
  /** The `quote_acceptances` row carrying the evidence. */
  acceptance_id: z.string().optional(),
  signatory_name: z.string().optional(),
  signatory_email: z.string().optional(),
  /** SHA-256 of the archived artifact — the same value stored on the record. */
  document_sha256: z.string().optional(),
  artifact_file_id: z.string().optional(),
  /** The PRD-003 contact the signatory was attributed to, and how. */
  contact_id: z.string().optional(),
  contact_match: z.string().optional(),
});
export type QuoteAcceptedV1 = z.infer<typeof quoteAcceptedV1>;
