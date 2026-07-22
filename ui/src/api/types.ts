export type InvoiceStatus = "draft" | "sent" | "overdue" | "partially_paid" | "paid" | "cancelled";

export interface Invoice {
  invoice_id: string;
  customer_id: string;
  status: InvoiceStatus;
  total_cents: number;
  amount_due_cents: number;
  currency: string;
  due_date: string;
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

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[];
}

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  account_id: string;
  code: string;
  name: string;
  type: AccountType;
  is_system: boolean;
}

export interface AccountBalance {
  account_id: string;
  balance_cents: number;
}

export type EntrySourceType = "invoice" | "payment" | "manual" | "reversal";

export interface EntrySummary {
  entry_id: string;
  entry_date: string;
  memo: string | null;
  currency: string;
  source_type: EntrySourceType;
  source_id: string | null;
  reverses_entry_id: string | null;
  total_cents: number;
}

export interface JournalLine {
  line_no: number;
  account_id: string;
  amount_cents: number;
}

export interface JournalEntry {
  entry_id: string;
  entry_date: string;
  memo: string | null;
  currency: string;
  source_type: EntrySourceType;
  source_id: string | null;
  reverses_entry_id: string | null;
  lines: JournalLine[];
}

export interface Customer {
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
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

export type QuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired" | "converted";

export interface Quote {
  quote_id: string;
  quote_number: string;
  customer_id: string;
  contact_id: string | null;
  deal_id: string | null;
  status: QuoteStatus;
  currency: string;
  issue_date: string;
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

export interface QuoteDetail extends Quote {
  lines: QuoteLine[];
}

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
  /** Company-wide default currency for new documents (ISO 4217). */
  base_currency: string;
}

export interface QuoteTemplateConfig {
  show_discount_column: boolean;
  show_line_notes: boolean;
  show_tax_line: boolean;
  show_signature_block: boolean;
  show_terms: boolean;
  tax_rate_bps: number;
  tax_label: string;
  terms_text: string;
  currency: string;
  number_format: "1,234.56" | "1.234,56";
  date_format: "DD/MM/YYYY" | "YYYY-MM-DD" | "DD MMM YYYY";
  bilingual: boolean;
  label_overrides: Record<string, string>;
}

export interface QuoteBranding {
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  font_family: string;
  template_config: QuoteTemplateConfig;
}

export interface PaymentHistoryEntry {
  payment_id: string;
  invoice_id: string;
  applied_cents: number;
  currency: string;
  received_at: string;
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

export type TicketStatus = "open" | "pending" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

export interface Ticket {
  ticket_id: string;
  customer_id: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export type MessageAuthor = "customer" | "agent" | "system";

export interface TicketMessage {
  message_id: string;
  ticket_id: string;
  author: MessageAuthor;
  body: string;
  created_at: string;
}

export interface TicketDetail extends Ticket {
  messages: TicketMessage[];
}

export interface Project {
  project_id: string;
  name: string;
  status: "active" | "archived";
  created_at: string;
}

export interface AgentEvent {
  event_id: string;
  event_type: string;
  source_module: string;
  occurred_at: string;
  trace_id: string;
  payload: Record<string, unknown>;
}

export interface CollectionsDecisionPayload {
  customer_id: string;
  risk_score: number;
  action: "remind" | "escalate" | "wait";
  channel: "email" | "whatsapp";
  message: string;
  source: "llm" | "fallback";
  trigger: "event" | "alarm";
}

export interface RiskFlaggedPayload {
  customer_id: string;
  risk_score: number;
  open_invoices: string[];
  total_due_cents: number;
}

export interface AgentSnapshot {
  customer_id: string;
  last_contact: string | null;
  risk_score: number;
  reminder_history: { invoice_id: string; sent_at: string; delivery_ref: string }[];
  escalation_stage: "none" | "reminded" | "escalated";
  open_overdue_invoices: string[];
}

export type IssueStatus = "todo" | "in_progress" | "done" | "cancelled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";

export interface Issue {
  issue_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

export type EmploymentType = "full_time" | "part_time" | "contract" | "intern";
export type EmployeeStatus = "active" | "inactive";

export interface Employee {
  employee_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  department_id: string;
  team_id: string | null;
  manager_employee_id: string | null;
  user_id: string | null;
  employment_type: EmploymentType;
  status: EmployeeStatus;
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Team {
  team_id: string;
  name: string;
  description: string | null;
  department_id: string | null;
  lead_employee_id: string | null;
  created_at: string;
  updated_at: string;
}
