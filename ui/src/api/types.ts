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
