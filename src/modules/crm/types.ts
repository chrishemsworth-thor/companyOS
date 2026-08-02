/** CRM module domain types (source_module: 'sales'). */

export interface Customer {
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  // Organization-level fields (migration 0013) — used by the Quotes "To" block.
  // `reg_no` is PRD-003's `registration_no` (SSM) and `tax_no` its `tax_id`
  // (SST); `address_line1..country` is its structured BILLING address. All
  // three predate PRD-003, so 0027 reused them rather than adding synonyms.
  legal_name: string | null;
  reg_no: string | null;
  tax_no: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  // Commercial attributes (PRD-003, migration 0027).
  industry: string | null;
  website: string | null;
  /**
   * Days from issue to due. NULL means "use the tenant default"
   * (`company_profile.default_payment_terms_days`), not "due immediately".
   * Consumed by `resolveDueDate` in the finance module — this is the field
   * PRD-003 stores precisely so invoice due dates compute themselves.
   */
  payment_terms_days: number | null;
  credit_limit_cents: number | null;
  preferred_channel: PreferredChannel | null;
  notes: string | null;
  ship_address_line1: string | null;
  ship_address_line2: string | null;
  ship_city: string | null;
  ship_state: string | null;
  ship_postcode: string | null;
  ship_country: string | null;
}

export type PreferredChannel = "email" | "whatsapp";

/** PRD-003's closed role vocabulary. Source of truth: `contactRoleSchema`. */
export type ContactRole = "primary" | "billing" | "technical" | "signatory" | "other";

/** A contact person at a customer organization. The quote "To" block names one. */
export interface Contact {
  contact_id: string;
  customer_id: string;
  name: string;
  title: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  /** Always equal to `roles.includes("primary")` — see contact-roles.ts. */
  is_primary: boolean;
  roles: ContactRole[];
  created_at: string;
}

export interface PipelineStage {
  stage_id: string;
  name: string;
  sort_order: number;
  is_won: boolean;
  is_lost: boolean;
}

export type DealStatus = "open" | "won" | "lost";

export interface Deal {
  deal_id: string;
  customer_id: string;
  title: string;
  value_cents: number;
  currency: string;
  stage_id: string;
  status: DealStatus;
  created_at: string;
  updated_at: string;
}

export type LeadStatus = "new" | "qualified" | "converted" | "lost";

/** A pre-customer prospect (migration 0018). Converts into customer (+ deal). */
export interface Lead {
  lead_id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  source: string;
  status: LeadStatus;
  notes: string | null;
  enriched_at: string | null;
  converted_customer_id: string | null;
  converted_deal_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ActivityKind = "note" | "call" | "email" | "meeting" | "reminder_sent";

export interface Activity {
  activity_id: string;
  customer_id: string;
  deal_id: string | null;
  kind: ActivityKind;
  body: string | null;
  occurred_at: string;
}

export interface PaymentHistoryEntry {
  payment_id: string;
  invoice_id: string;
  applied_cents: number;
  currency: string;
  received_at: string;
}
