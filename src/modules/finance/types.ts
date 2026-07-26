/**
 * Finance module domain types — the shapes the gateway exposes to agents.
 * Row-mapped from D1; money is always integer cents.
 */

export type InvoiceStatus =
  | "draft"
  | "sent"
  | "overdue"
  | "partially_paid"
  | "paid"
  | "cancelled";

export interface Invoice {
  invoice_id: string;
  customer_id: string;
  status: InvoiceStatus;
  total_cents: number;
  amount_due_cents: number;
  currency: string;
  due_date: string; // ISO date
  issued_at: string | null;
  sent_at: string | null;
  paid_at: string | null;
}

export interface InvoiceLine {
  line_no: number;
  description: string;
  quantity: number;
  unit_cents: number;
}

export interface Payment {
  payment_id: string;
  customer_id: string;
  amount_cents: number;
  currency: string;
  method: string;
  received_at: string;
  entry_id: string | null;
}

export interface PaymentApplication {
  invoice_id: string;
  applied_cents: number;
}

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  account_id: string;
  code: string;
  name: string;
  type: AccountType;
  is_system: boolean;
}

export type EntrySourceType = "invoice" | "payment" | "manual" | "reversal";

/**
 * Analytical dimensions on a journal line (PRD-001a). All optional: an entry
 * with none posts fine and lands in the profitability rollup's "Unallocated"
 * bucket. Immutable once posted — the ledger's append-only triggers cover
 * dimensions exactly as they cover amounts, so a mis-tag is corrected by
 * reversing and re-posting.
 */
export interface LineDimensions {
  customer_id?: string | null;
  project_id?: string | null;
  /** A department id from src/departments/registry.ts, validated in the service. */
  department_code?: string | null;
  employee_id?: string | null;
  /** Reserved free text for a tenant's existing cost-centre vocabulary. */
  cost_centre?: string | null;
}

export interface JournalLine extends LineDimensions {
  line_no: number;
  account_id: string;
  /** Signed: > 0 debit, < 0 credit. */
  amount_cents: number;
}

export interface JournalEntry {
  entry_id: string;
  entry_date: string; // ISO date
  memo: string | null;
  currency: string;
  source_type: EntrySourceType;
  source_id: string | null;
  reverses_entry_id: string | null;
  lines: JournalLine[];
}
