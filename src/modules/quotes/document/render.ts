import type { Contact, Customer } from "../../crm/types";
import type { QuoteBranding } from "../branding";
import type { CompanyProfile, Quote, QuoteLine } from "../types";
import { formatDate, formatMoney } from "./format";
import { resolveLabels } from "./labels";

/** Minimal HTML escaping for all interpolated dynamic text. */
function esc(value: string | null | undefined): string {
  if (value == null) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function addressLines(a: {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
}): string[] {
  const cityLine = [a.postcode, a.city].filter(Boolean).join(" ");
  const region = [cityLine, a.state].filter(Boolean).join(", ");
  return [a.address_line1, a.address_line2, region, a.country].filter(
    (l): l is string => !!l && l.length > 0,
  );
}

export interface RenderQuoteInput {
  quote: Quote;
  lines: QuoteLine[];
  customer: Customer;
  contact: Contact | null;
  profile: CompanyProfile | null;
  branding: QuoteBranding;
}

/**
 * Render a fully self-contained, per-company-branded HTML quote. Pure function
 * (no I/O) — the route loads the data and passes it in. Brand colours/font/logo
 * are inlined into a <style> block; `@media print` + `@page` make the browser's
 * "Save as PDF" produce a clean A4 document. Which columns/sections appear is
 * driven entirely by the tenant's `template_config`.
 */
export function renderQuoteHtml(input: RenderQuoteInput): string {
  const { quote, lines, customer, contact, profile, branding } = input;
  const cfg = branding.template_config;
  const L = resolveLabels(cfg);
  const nf = cfg.number_format;
  const df = cfg.date_format;
  const money = (c: number) => formatMoney(c, quote.currency, nf);

  const showDiscount = cfg.show_discount_column;
  const showNotes = cfg.show_line_notes;
  const showTax = cfg.show_tax_line && quote.tax_cents > 0;

  const sellerName = esc(profile?.legal_name ?? "Your Company");
  const sellerMeta = profile
    ? [
        ...addressLines(profile).map(esc),
        profile.reg_no ? `${esc(L.reg_no)}: ${esc(profile.reg_no)}` : "",
        profile.tax_no ? `${esc(L.tax_no)}: ${esc(profile.tax_no)}` : "",
        profile.phone ? `${esc(L.phone)}: ${esc(profile.phone)}` : "",
        profile.email ? `${esc(L.email)}: ${esc(profile.email)}` : "",
      ].filter(Boolean)
    : [];

  const buyerName = esc(customer.legal_name ?? customer.name);
  const buyerMeta = [
    contact ? `<strong>${esc(contact.name)}</strong>` : "",
    contact?.title ? esc(contact.title) : "",
    contact?.department ? esc(contact.department) : "",
    ...addressLines(customer).map(esc),
    (contact?.phone ?? customer.phone) ? `${esc(L.phone)}: ${esc(contact?.phone ?? customer.phone)}` : "",
    (contact?.email ?? customer.email) ? `${esc(L.email)}: ${esc(contact?.email ?? customer.email)}` : "",
  ].filter(Boolean);

  const colSpanBeforeTotals = 2 + (showDiscount ? 1 : 0); // qty + unit price [+ discount]

  const headerCols = [
    `<th class="c-no">${esc(L.col_no)}</th>`,
    `<th>${esc(L.col_item)}</th>`,
    `<th class="c-num">${esc(L.col_qty)}</th>`,
    `<th class="c-num">${esc(L.col_unit_price)}</th>`,
    showDiscount ? `<th class="c-num">${esc(L.col_discount)}</th>` : "",
    `<th class="c-num">${esc(L.col_line_total)}</th>`,
  ]
    .filter(Boolean)
    .join("");

  const bodyRows = lines
    .map((line) => {
      const desc = [
        line.description ? `<div class="line-desc">${esc(line.description)}</div>` : "",
        showNotes && line.note ? `<div class="line-note">${esc(line.note)}</div>` : "",
      ].join("");
      const qty = `${line.quantity}${line.unit ? ` ${esc(line.unit)}` : ""}`;
      return `<tr>
        <td class="c-no">${line.line_no}</td>
        <td><div class="line-item">${esc(line.item_name)}</div>${desc}</td>
        <td class="c-num">${esc(qty)}</td>
        <td class="c-num">${money(line.unit_cents)}</td>
        ${showDiscount ? `<td class="c-num">${money(line.discount_cents)}</td>` : ""}
        <td class="c-num">${money(line.line_total_cents)}</td>
      </tr>`;
    })
    .join("");

  const totalRow = (label: string, value: string, strong = false) => `<tr class="${strong ? "total-grand" : "total-row"}">
      <td class="total-spacer" colspan="${colSpanBeforeTotals + 1}"></td>
      <td class="total-label">${esc(label)}</td>
      <td class="c-num">${value}</td>
    </tr>`;

  const totals = [
    totalRow(L.subtotal, money(quote.subtotal_cents)),
    showDiscount && quote.discount_total_cents > 0
      ? totalRow(L.discount_total, `- ${money(quote.discount_total_cents)}`)
      : "",
    showTax ? totalRow(cfg.tax_label, money(quote.tax_cents)) : "",
    totalRow(L.grand_total, money(quote.grand_total_cents), true),
  ]
    .filter(Boolean)
    .join("");

  const notesBlock = quote.notes
    ? `<section class="notes"><h3>${esc(L.notes)}</h3><p>${esc(quote.notes)}</p></section>`
    : "";

  const termsBlock =
    cfg.show_terms && cfg.terms_text
      ? `<section class="terms"><h3>${esc(L.terms_title)}</h3><p>${esc(cfg.terms_text)}</p></section>`
      : "";

  const signatureBlock = cfg.show_signature_block
    ? `<section class="signatures">
        <div class="sig-box">
          <div class="sig-role">${esc(L.prepared_by)}</div>
          <div class="sig-line"></div>
          <div class="sig-name">${esc(quote.prepared_by ?? profile?.default_prepared_by ?? "")}</div>
          <div class="sig-company">${sellerName}</div>
        </div>
        <div class="sig-box">
          <div class="sig-role">${esc(L.approved_by)}</div>
          <div class="sig-line"></div>
          <div class="sig-name">${esc(quote.approved_by ?? "")}</div>
          <div class="sig-company">${sellerName}</div>
        </div>
        <div class="sig-box">
          <div class="sig-role">${esc(L.customer_confirmation)}</div>
          <div class="sig-line"></div>
          <div class="sig-name">${esc(L.name)}: ${buyerName}</div>
          <div class="sig-company">${esc(L.date)}: __________</div>
        </div>
      </section>`
    : "";

  const logo = branding.logo_url
    ? `<img class="logo" src="${esc(branding.logo_url)}" alt="${sellerName}" />`
    : `<div class="logo-text">${sellerName}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(quote.quote_number)} · ${sellerName}</title>
<style>
  :root {
    --primary: ${esc(branding.primary_color)};
    --accent: ${esc(branding.accent_color)};
  }
  * { box-sizing: border-box; }
  body {
    font-family: ${branding.font_family};
    color: #1f2933; margin: 0; background: #f4f5f7;
    font-size: 13px; line-height: 1.5;
  }
  .page {
    max-width: 794px; margin: 24px auto; background: #fff; padding: 40px;
    box-shadow: 0 1px 4px rgba(0,0,0,.12);
  }
  header.doc {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 3px solid var(--primary); padding-bottom: 20px; margin-bottom: 24px;
  }
  .logo { max-height: 64px; max-width: 240px; }
  .logo-text { font-size: 20px; font-weight: 700; color: var(--primary); }
  .doc-meta { text-align: right; }
  .doc-title { font-size: 22px; font-weight: 700; color: var(--primary); letter-spacing: .04em; }
  .doc-meta table { margin-top: 8px; margin-left: auto; border-collapse: collapse; }
  .doc-meta td { padding: 1px 0 1px 12px; }
  .doc-meta .k { color: #6b7280; text-align: right; }
  .parties { display: flex; gap: 32px; margin-bottom: 24px; }
  .party { flex: 1; }
  .party h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--accent); margin: 0 0 6px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px;
  }
  .party .party-name { font-weight: 700; font-size: 14px; }
  .party div { margin: 1px 0; }
  table.lines { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  table.lines th {
    background: var(--primary); color: #fff; text-align: left; padding: 8px 10px; font-size: 11px;
    text-transform: uppercase; letter-spacing: .03em;
  }
  table.lines td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  .c-num { text-align: right; white-space: nowrap; }
  .c-no { width: 32px; text-align: center; }
  .line-item { font-weight: 600; }
  .line-desc { color: #4b5563; font-size: 12px; }
  .line-note { color: #6b7280; font-size: 11px; font-style: italic; margin-top: 2px; }
  .total-row .total-label, .total-grand .total-label { text-align: right; padding-right: 10px; color: #4b5563; }
  .total-spacer { border-bottom: none !important; }
  .total-grand td { font-weight: 700; font-size: 15px; color: var(--primary); border-top: 2px solid var(--primary); }
  section { margin-top: 24px; }
  section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); margin: 0 0 6px; }
  .terms p, .notes p { white-space: pre-wrap; color: #374151; }
  .signatures { display: flex; gap: 24px; margin-top: 48px; }
  .sig-box { flex: 1; font-size: 12px; }
  .sig-role { font-weight: 600; color: var(--accent); margin-bottom: 32px; }
  .sig-line { border-top: 1px solid #9ca3af; margin-bottom: 6px; }
  .sig-company { color: #6b7280; }
  @page { size: A4; margin: 14mm; }
  @media print {
    body { background: #fff; }
    .page { box-shadow: none; margin: 0; max-width: none; padding: 0; }
  }
</style>
</head>
<body>
  <div class="page">
    <header class="doc">
      <div>${logo}</div>
      <div class="doc-meta">
        <div class="doc-title">${esc(L.quote_title)}</div>
        <table>
          <tr><td class="k">${esc(L.quote_no)}</td><td>${esc(quote.quote_number)}</td></tr>
          <tr><td class="k">${esc(L.issue_date)}</td><td>${esc(formatDate(quote.issue_date, df))}</td></tr>
          ${quote.expiry_date ? `<tr><td class="k">${esc(L.expiry_date)}</td><td>${esc(formatDate(quote.expiry_date, df))}</td></tr>` : ""}
        </table>
      </div>
    </header>

    <div class="parties">
      <div class="party">
        <h2>${esc(L.from)}</h2>
        <div class="party-name">${sellerName}</div>
        ${sellerMeta.map((l) => `<div>${l}</div>`).join("")}
      </div>
      <div class="party">
        <h2>${esc(L.to)}</h2>
        <div class="party-name">${buyerName}</div>
        ${buyerMeta.map((l) => `<div>${l}</div>`).join("")}
      </div>
    </div>

    <table class="lines">
      <thead><tr>${headerCols}</tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>${totals}</tfoot>
    </table>

    ${notesBlock}
    ${termsBlock}
    ${signatureBlock}
  </div>
</body>
</html>`;
}
