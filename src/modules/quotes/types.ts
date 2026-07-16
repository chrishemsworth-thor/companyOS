/** Quotes module domain types (source_module: 'sales'). Money is integer cents. */

export type QuoteStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired"
  | "converted";

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
}
