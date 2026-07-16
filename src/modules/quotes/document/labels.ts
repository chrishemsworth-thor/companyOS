import type { QuoteTemplateConfig } from "../branding";

/**
 * Default (English) document labels. Every visible string on the quote goes
 * through this map so a company can override any of them via
 * `template_config.label_overrides` (and, later, a bilingual pack can supply a
 * second language without touching the renderer).
 */
export const DEFAULT_LABELS = {
  quote_title: "QUOTATION",
  quote_no: "Quote No.",
  issue_date: "Date",
  expiry_date: "Valid Until",
  from: "From",
  to: "To",
  phone: "Phone",
  email: "Email",
  reg_no: "Reg. No.",
  tax_no: "Tax No.",
  col_no: "No",
  col_item: "Item",
  col_description: "Description",
  col_qty: "Qty",
  col_unit_price: "Unit Price",
  col_discount: "Discount",
  col_line_total: "Amount",
  subtotal: "Subtotal",
  discount_total: "Total Discount",
  grand_total: "Total",
  notes: "Notes",
  terms_title: "Terms & Conditions",
  prepared_by: "Prepared By",
  approved_by: "Approved By",
  customer_confirmation: "Customer Confirmation",
  signature: "Signature",
  name: "Name",
  designation: "Designation",
  company: "Company",
  date: "Date",
} as const;

export type LabelKey = keyof typeof DEFAULT_LABELS;
export type Labels = Record<LabelKey, string>;

/** Overlay a tenant's label overrides on top of the defaults. */
export function resolveLabels(config: QuoteTemplateConfig): Labels {
  const labels = { ...DEFAULT_LABELS } as Labels;
  for (const [key, value] of Object.entries(config.label_overrides)) {
    if (key in labels && typeof value === "string" && value.length > 0) {
      labels[key as LabelKey] = value;
    }
  }
  return labels;
}
