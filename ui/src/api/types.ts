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

export type LeadStatus = "new" | "qualified" | "converted" | "lost";

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

// ── Approvals (PRD-000b) and notifications (PRD-000c) ────────────────────────

export type ApprovalState = "pending" | "approved" | "rejected" | "cancelled";

/**
 * `subject_type` is deliberately a plain string, not a union of the types this
 * build knows about. The backend column has no CHECK so a newer server can
 * legitimately return a value this bundle has never heard of, and PRD-007
 * requires the inbox to fall back to a generic card rather than crash on one.
 * Narrowing it here would turn that runtime fallback into a compile-time lie.
 */
export interface Approval {
  approval_id: string;
  subject_type: string;
  subject_id: string;
  requested_by: string | null;
  approver_user_id: string;
  state: ApprovalState;
  decision_comment: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  idempotency_key: string | null;
}

export interface Notification {
  notification_id: string;
  /** The source event_type, e.g. `approval.requested`. */
  type: string;
  subject_type: string;
  subject_id: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPage {
  items: Notification[];
  next_cursor: string | null;
  /** Every unread row, not just this page — this is the badge number. */
  unread_count: number;
}

// ── Leave (PRD-006c) ─────────────────────────────────────────────────────────

/**
 * `cancellation_pending` is the state an approved request enters when the
 * employee asks to hand the leave back: PRD-006 requires re-approval for that,
 * so a second approval is raised and the leave stays booked until it is decided.
 */
export type LeaveRequestState =
  | "pending"
  | "approved"
  | "rejected"
  | "cancellation_pending"
  | "cancelled";

export interface LeaveType {
  code: string;
  name: string;
  paid: boolean;
  requires_attachment: boolean;
  max_consecutive_days: number | null;
  allows_half_day: boolean;
  allows_negative_balance: boolean;
}

export interface LeaveBalance {
  leave_type_code: string;
  leave_type_name: string;
  entitlement_days: number;
  carry_forward_days: number;
  taken_days: number;
  pending_days: number;
  available_days: number;
  /**
   * `default` means the server had no configured policy to read and supplied a
   * provisional figure. The console must say so rather than present a guess as
   * policy — see the S6 seam in src/modules/people/leave/policy-port.ts.
   */
  entitlement_source: "policy" | "default";
}

export interface LeaveRequest {
  leave_request_id: string;
  employee_id: string;
  employee_name: string;
  employee_user_id: string | null;
  leave_type_code: string;
  start_date: string;
  end_date: string;
  start_half_day: boolean;
  end_half_day: boolean;
  working_days: number;
  reason: string | null;
  attachment_file_id: string | null;
  state: LeaveRequestState;
  approval_id: string | null;
  decided_at: string | null;
  cancelled_at: string | null;
  created_by: string | null;
// ── Expense claims (PRD-006a) ────────────────────────────────────────────────

export type ClaimStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "paid"
  | "cancelled";

export interface ExpenseClaim {
  claim_id: string;
  employee_id: string;
  claim_date: string;
  description: string | null;
  currency: string;
  total_cents: number;
  /** Captured, not posted — the SST Input leg lands with the tax work. */
  tax_cents: number;
  status: ClaimStatus;
  project_id: string | null;
  department_code: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  approval_id: string | null;
  rejection_comment: string | null;
  rejected_at: string | null;
  /** The `Dr expense / Cr reimbursements payable` entry. Null until approved. */
  entry_id: string | null;
  paid_entry_id: string | null;
  payment_reference: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamOverlap {
  leave_request_id: string;
  employee_id: string;
  employee_name: string;
  leave_type_code: string;
  start_date: string;
  end_date: string;
  working_days: number;
  state: LeaveRequestState;
}

export interface LeaveExcludedDay {
  date: string;
  reason: "non_working_day" | "public_holiday";
}

export interface LeaveWarning {
  code: "team_overlap" | "policy_not_configured" | "unpaid_leave";
  message: string;
}

export interface LeaveBlocker {
  code: string;
  message: string;
  shortfall_days?: number;
  available_days?: number;
  conflicting_leave_request_id?: string;
}

/**
 * What `POST /v1/leave/preview` returns — the working days computed *before*
 * submission, which PRD-006 requires be shown to the employee. `blockers` empty
 * is exactly the condition under which submit will succeed, because the server
 * runs the identical computation on both paths.
 */
export interface LeavePreview {
  leave_type_code: string;
  start_date: string;
  end_date: string;
  start_half_day: boolean;
  end_half_day: boolean;
  working_days: number;
  calendar_days: number;
  excluded_days: LeaveExcludedDay[];
  balance: LeaveBalance;
  balance_after_days: number;
  team_overlaps: TeamOverlap[];
  warnings: LeaveWarning[];
  blockers: LeaveBlocker[];
  calendar_source: "policy" | "default";
}

/** `GET /v1/leave/requests/:id` — the row plus the context a decision needs. */
export interface LeaveRequestDetail extends LeaveRequest {
  balance: LeaveBalance | null;
  balance_after_days: number | null;
  team_overlaps: TeamOverlap[];
  excluded_days: LeaveExcludedDay[];
  approval: Approval | null;
}

export interface LeaveRequestPage {
  items: LeaveRequest[];
  next_cursor: string | null;
}

export interface LeaveBalancesResponse {
  employee_id: string;
  year: number;
  items: LeaveBalance[];
}

export interface LeaveCalendarResponse {
  from: string;
  to: string;
  year: number;
  items: LeaveRequest[];
export interface ExpenseClaimLine {
  line_no: number;
  category_id: string;
  category_code: string;
  category_name: string;
  category_kind: "standard" | "mileage";
  /** The GL account this line debits on approval. */
  account_code: string;
  account_name: string;
  description: string | null;
  distance_km: number | null;
  amount_cents: number;
  tax_cents: number;
  receipt_file_id: string;
  /** All three are null when the receipt has been deleted — render as unavailable. */
  receipt_filename: string | null;
  receipt_content_type: string | null;
  receipt_size_bytes: number | null;
  project_id: string | null;
  department_code: string | null;
}

/**
 * A category on this claim that is over its configured limit. Advisory: PRD-006
 * warns on a breach and still lets the claim submit.
 */
export interface ClaimLimitWarning {
  category_id: string;
  category_code: string;
  category_name: string;
  limit_cents: number;
  claimed_cents: number;
  over_by_cents: number;
}

export interface ClaimDetail {
  claim: ExpenseClaim;
  lines: ExpenseClaimLine[];
  limit_warnings: ClaimLimitWarning[];
}
