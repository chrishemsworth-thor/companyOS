/** CRM module domain types (source_module: 'sales'). */

export interface Customer {
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  // Organization-level fields (migration 0013) — used by the Quotes "To" block.
  legal_name: string | null;
  reg_no: string | null;
  tax_no: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
}

/** A contact person at a customer organization. The quote "To" block names one. */
export interface Contact {
  contact_id: string;
  customer_id: string;
  name: string;
  title: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
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
