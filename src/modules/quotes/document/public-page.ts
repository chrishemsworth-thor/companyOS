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
/** Everything the signing panel needs to render itself. */
export interface SignPanelInput {
  token: string;
  agreementText: string;
  agreementVersion: string;
  /** Pre-filled from the customer's `signatory` contact (PRD-003) when known. */
  prefill: { name: string; email: string } | null;
}

const SIGN_STYLES = `
  .sign-panel {
    max-width: 794px; margin: 20px auto 0; background: #fff; padding: 24px 28px;
    border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,.12);
  }
  .sign-panel h2 { font-size: 15px; margin: 0 0 4px; }
  .sign-panel .lede { color: #4b5563; font-size: 13px; margin: 0 0 16px; }
  .sign-grid { display: flex; gap: 16px; flex-wrap: wrap; }
  .sign-grid label { flex: 1 1 240px; font-size: 12px; color: #374151; }
  .sign-grid input[type=text], .sign-grid input[type=email] {
    display: block; width: 100%; margin-top: 4px; padding: 8px 10px; font-size: 14px;
    border: 1px solid #d1d5db; border-radius: 6px; font-family: inherit;
  }
  .sign-agree { display: flex; gap: 10px; align-items: flex-start; margin: 16px 0; font-size: 12px; color: #374151; }
  .sign-agree input { margin-top: 3px; }
  .sign-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .sign-actions button {
    font: inherit; font-size: 14px; padding: 10px 20px; border-radius: 6px; cursor: pointer;
    border: 1px solid transparent;
  }
  .btn-accept { background: var(--primary); color: #fff; }
  .btn-accept[disabled] { opacity: .5; cursor: not-allowed; }
  .btn-decline { background: #fff; color: #6b7280; border-color: #d1d5db; }
  .sign-error {
    display: none; margin-top: 12px; padding: 10px 12px; border-radius: 6px;
    background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; font-size: 12px;
  }
  .sign-version { margin-top: 12px; font-size: 10px; color: #9ca3af; }`;

/**
 * The accept/decline panel.
 *
 * Deliberately plain HTML with a small inline script and no framework: this page
 * is served to a customer on an unknown device, is the legally operative surface
 * of the whole feature, and has to work. The Accept button stays disabled until
 * the agreement box is ticked, which is the client-side half of PRD-004's
 * explicit-consent requirement — the server-side half (`agreed !== true` is a
 * 422) is the one that actually enforces it, because a customer can always send
 * the request by hand.
 *
 * Escaped through `esc` like everything else: the pre-fill comes from a contact
 * record a tenant typed in, which is not trusted input.
 */
function renderSignPanel(input: SignPanelInput): string {
  const name = input.prefill ? esc(input.prefill.name) : "";
  const email = input.prefill ? esc(input.prefill.email) : "";
  return `  <section class="sign-panel">
    <h2>Accept this quotation</h2>
    <p class="lede">Enter your details and confirm the statement below. No account is needed.</p>
    <form id="sign-form" autocomplete="on">
      <div class="sign-grid">
        <label>Your full name
          <input type="text" id="sig-name" name="signatory_name" required maxlength="200" value="${name}" />
        </label>
        <label>Your email address
          <input type="email" id="sig-email" name="signatory_email" required maxlength="320" value="${email}" />
        </label>
      </div>
      <label class="sign-agree">
        <input type="checkbox" id="sig-agree" />
        <span>${esc(input.agreementText)}</span>
      </label>
      <div class="sign-actions">
        <button type="submit" class="btn-accept" id="sig-accept" disabled>Accept quotation</button>
        <button type="button" class="btn-decline" id="sig-decline">Decline</button>
      </div>
      <div class="sign-error" id="sig-error"></div>
      <p class="sign-version">Agreement version ${esc(input.agreementVersion)}</p>
    </form>
  </section>
  <script>
    (function () {
      var f = document.getElementById("sign-form");
      var agree = document.getElementById("sig-agree");
      var accept = document.getElementById("sig-accept");
      var decline = document.getElementById("sig-decline");
      var err = document.getElementById("sig-error");
      var base = ${JSON.stringify(`/q/${input.token}`)};

      agree.addEventListener("change", function () { accept.disabled = !agree.checked; });

      function fail(message) {
        err.textContent = message;
        err.style.display = "block";
        accept.disabled = !agree.checked;
        decline.disabled = false;
      }

      function submit(path, body) {
        err.style.display = "none";
        accept.disabled = true;
        decline.disabled = true;
        fetch(base + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
          .then(function (res) {
            if (res.ok) { window.location.reload(); return null; }
            return res.json().then(function (b) {
              fail((b && b.error) || "Something went wrong. Please try again.");
            });
          })
          .catch(function () { fail("Could not reach the server. Please check your connection."); });
      }

      function details() {
        return {
          signatory_name: document.getElementById("sig-name").value,
          signatory_email: document.getElementById("sig-email").value,
        };
      }

      f.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!agree.checked) { fail("Please confirm the statement above before accepting."); return; }
        var body = details();
        body.agreed = true;
        submit("/accept", body);
      });

      decline.addEventListener("click", function () {
        var reason = window.prompt("Optionally, let them know why (this is recorded):") || "";
        var body = details();
        body.reason = reason;
        submit("/decline", body);
      });
    })();
  </script>`;
}

/** The signing panel plus the styles it needs, ready for `renderPublicQuotePage`. */
export function signPanel(input: SignPanelInput): { actions: string; actionStyles: string } {
  return { actions: renderSignPanel(input), actionStyles: SIGN_STYLES };
}

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
