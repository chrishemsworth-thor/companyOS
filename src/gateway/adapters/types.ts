import type { EventEnvelope } from "../../schemas/envelope";

/**
 * Normalized shapes the gateway exposes. Agents and the Insights layer only
 * ever see these — never module-native (ERPNext/Twenty/...) payloads.
 */
export interface NormalizedInvoice {
  invoice_id: string;
  customer_id: string;
  status: "draft" | "sent" | "overdue" | "partially_paid" | "paid" | "cancelled";
  amount_due: number;
  currency: string;
  due_date: string; // ISO date
}

export interface NormalizedCustomer {
  customer_id: string;
  name: string;
  email?: string;
  phone?: string;
}

export interface PaymentHistoryEntry {
  invoice_id: string;
  amount_paid: number;
  currency: string;
  paid_at: string; // ISO datetime
}

export interface ReminderRequest {
  invoice_id: string;
  customer_id: string;
  channel: "email" | "whatsapp";
  message: string;
}

/** Per-tenant connection details for one module instance (from tenant_credentials). */
export interface ModuleCredentials {
  base_url: string;
  api_key: string;
  api_secret: string;
}

/**
 * The translation-layer contract. Every OSS module (ERPNext, Twenty, Plane,
 * Libredesk) plugs into the gateway by implementing this interface:
 *   normalized request → module-native API call → normalized response.
 *
 * Implementations must be stateless: credentials are passed per-call because
 * each tenant runs its own module instance.
 */
export interface ModuleAdapter {
  readonly module: "finance" | "people" | "sales" | "support" | "build";

  listInvoices(
    creds: ModuleCredentials,
    filter: { status?: NormalizedInvoice["status"] },
  ): Promise<NormalizedInvoice[]>;

  getInvoice(creds: ModuleCredentials, invoiceId: string): Promise<NormalizedInvoice | null>;

  getCustomer(creds: ModuleCredentials, customerId: string): Promise<NormalizedCustomer | null>;

  getPaymentHistory(creds: ModuleCredentials, customerId: string): Promise<PaymentHistoryEntry[]>;

  /** Deliver an agent-composed nudge. Returns a delivery reference. */
  sendReminder(creds: ModuleCredentials, req: ReminderRequest): Promise<{ delivery_ref: string }>;

  /**
   * Translate the module's native webhook payload into a normalized event
   * envelope, or null if the webhook is one we don't care about.
   */
  normalizeWebhook(tenantId: string, body: unknown): EventEnvelope | null;
}
