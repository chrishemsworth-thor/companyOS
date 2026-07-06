/** CRM module domain types (source_module: 'sales'). */

export interface Customer {
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
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
