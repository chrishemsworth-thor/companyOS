/**
 * The agreement a customer ticks before accepting a quote (PRD-004 P0).
 *
 * ## Not legal advice
 *
 * PRD-004 carries an explicit **blocking-before-customer-use** open question:
 *
 *   > Confirm with a Malaysian lawyer that click-plus-audit-trail acceptance
 *   > meets ECA 2006 requirements for the contract types SME customers will
 *   > use, and what the agreement text should say. Do not rely on this PRD's
 *   > summary.
 *
 * The wording below is a placeholder written to be reviewed, not to be relied
 * on. The flow can be built and tested against it; a tenant should not put a
 * real customer through it until a lawyer has signed off the words.
 *
 * ## Why the version matters
 *
 * Every acceptance stores BOTH the version and the exact text that was on
 * screen. Bumping the version is therefore the only legitimate way to change
 * the wording: past records keep the words their signatory actually saw, and
 * a record that silently re-renders under new terms is not a record at all.
 *
 * Changing `AGREEMENT_TEXT` without bumping `AGREEMENT_VERSION` would leave two
 * different texts sharing one version label — which is the one failure mode
 * this pair exists to prevent.
 */

export const AGREEMENT_VERSION = "quote-acceptance-2026-08-v1";

export const AGREEMENT_TEXT =
  "By ticking this box and clicking Accept, I confirm that I am authorised to " +
  "accept this quotation on behalf of the recipient organisation, that I have " +
  "read the quotation shown above, and that I agree to its contents, pricing " +
  "and any stated terms. I understand that this electronic acceptance is " +
  "intended to have the same effect as a signature, and that a copy of the " +
  "document as accepted will be retained together with the date, time and " +
  "network address of this acceptance.";

/** The current agreement, as shown and as stored. */
export function currentAgreement(): { version: string; text: string } {
  return { version: AGREEMENT_VERSION, text: AGREEMENT_TEXT };
}
