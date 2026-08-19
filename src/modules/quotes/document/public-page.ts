import type { QuoteDocumentParts } from "./render";
import { htmlDocument } from "./render";

/**
 * The public quote page (PRD-004 P0) — what a customer sees at `/q/:token`.
 *
 * It is the SAME document the operator sees, wrapped in a customer-facing
 * shell: a status banner, and (from phase C) the accept/decline controls. It
 * carries no console chrome — no nav, no login, no workspace switcher — because
 * the reader is not a user of this system and never will be.
 *
 * Rendering the document from the same parts as the internal route is
 * deliberate. A separate customer-facing template would drift, and the first
 * time it drifted the customer would be agreeing to something the operator
 * never saw.
 */

/** What the reader is being told about the state of this link. */
export type PublicQuoteState =
  | "open"
  | "expired"
  | "revoked"
  | "accepted"
  | "declined"
  | "converted";

export interface PublicPageInput {
  document: QuoteDocumentParts;
  state: PublicQuoteState;
  /** The seller's name, for the standalone notice pages. */
  sellerName: string;
  /** Markup injected below the banner — the accept/decline form in phase C. */
  actions?: string;
  /** Extra CSS the injected markup needs. */
  actionStyles?: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Banner copy per state. Each one answers "what do I do now?", because a
 * customer who opens a stale link and reads "404" learns nothing and calls
 * their account manager.
 */
const BANNERS: Record<PublicQuoteState, { tone: string; title: string; detail: string }> = {
  open: {
    tone: "info",
    title: "This quotation is awaiting your response.",
    detail: "Please review the details below.",
  },
  expired: {
    tone: "warn",
    title: "This quotation has expired.",
    detail:
      "The validity period has passed, so it can no longer be accepted. Please contact us for an updated quotation.",
  },
  revoked: {
    tone: "warn",
    title: "This link is no longer active.",
    detail: "The sender has withdrawn it. Please contact us if you still need this quotation.",
  },
  accepted: {
    tone: "ok",
    title: "This quotation has been accepted.",
    detail: "A copy of the accepted document is kept on record.",
  },
  declined: {
    tone: "warn",
    title: "This quotation was declined.",
    detail: "Please contact us if this was not intended.",
  },
  converted: {
    tone: "ok",
    title: "This quotation has been accepted and invoiced.",
    detail: "A copy of the accepted document is kept on record.",
  },
};

const PUBLIC_STYLES = `
  .public-banner {
    max-width: 794px; margin: 24px auto -8px; padding: 14px 18px; border-radius: 8px;
    font-size: 13px; line-height: 1.5; border: 1px solid transparent;
  }
  .public-banner strong { display: block; font-size: 14px; margin-bottom: 2px; }
  .public-banner.info { background: #eef2ff; border-color: #c7d2fe; color: #312e81; }
  .public-banner.warn { background: #fff7ed; border-color: #fed7aa; color: #7c2d12; }
  .public-banner.ok   { background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }
  .public-foot {
    max-width: 794px; margin: 16px auto 48px; font-size: 11px; color: #6b7280; text-align: center;
  }
  @media print { .public-banner, .public-foot, .sign-panel { display: none !important; } }`;

/**
 * The full page for a resolvable link, whatever state it is in.
 *
 * An expired or revoked link still renders the DOCUMENT, not just a notice: the
 * customer is being told they can no longer accept it, which is only useful
 * alongside what "it" was. PRD-004 asks for an explanatory state rather than a
 * 404, and a bare "expired" page with no quote on it is barely less of a dead
 * end than the 404 it replaced.
 */
export function renderPublicQuotePage(input: PublicPageInput): string {
  const banner = BANNERS[input.state];
  const { document: doc } = input;
  return htmlDocument({
    title: doc.title,
    styles: `${doc.styles}\n${PUBLIC_STYLES}${input.actionStyles ?? ""}`,
    body:
      `  <div class="public-banner ${banner.tone}">` +
      `<strong>${esc(banner.title)}</strong>${esc(banner.detail)}</div>\n` +
      `${doc.body}\n` +
      `${input.actions ?? ""}` +
      `  <div class="public-foot">This document was issued by ${esc(input.sellerName)}.</div>`,
  });
}

/**
 * The page for a token that resolves to nothing.
 *
 * Deliberately says nothing about whether the token ever existed — PRD-004's
 * "404 with no information leakage". One body for every miss, so response size
 * and content cannot be used to tell a wrong token from a deleted one.
 */
export function renderUnknownLinkPage(): string {
  return htmlDocument({
    title: "Link not found",
    styles: `
  body { font-family: Helvetica, Arial, sans-serif; background: #f4f5f7; color: #1f2933; margin: 0; }
  .notice {
    max-width: 520px; margin: 96px auto; background: #fff; padding: 32px; border-radius: 10px;
    box-shadow: 0 1px 4px rgba(0,0,0,.12); text-align: center; line-height: 1.6;
  }
  .notice h1 { font-size: 18px; margin: 0 0 8px; }
  .notice p { color: #4b5563; font-size: 14px; margin: 0; }`,
    body: `  <div class="notice">
    <h1>This link is not valid.</h1>
    <p>Please check the address, or ask your contact to send it again.</p>
  </div>`,
  });
}
