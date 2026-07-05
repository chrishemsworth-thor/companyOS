import { makeEnvelope, type EventEnvelope } from "../../schemas/envelope";
import type {
  ModuleAdapter,
  ModuleCredentials,
  NormalizedCustomer,
  NormalizedInvoice,
  PaymentHistoryEntry,
  ReminderRequest,
} from "./types";

/**
 * ERPNext (Frappe) adapter — the Finance module.
 *
 * Live mode talks to the Frappe REST API (`/api/resource/<DocType>`) with
 * `Authorization: token <api_key>:<api_secret>`. Mock mode returns canned data
 * so the vertical slice runs end-to-end without a live ERPNext instance.
 */
export class ErpNextAdapter implements ModuleAdapter {
  readonly module = "finance" as const;

  constructor(private readonly mockMode: boolean) {}

  private async frappeGet<T>(creds: ModuleCredentials, path: string): Promise<T> {
    const res = await fetch(`${creds.base_url}${path}`, {
      headers: {
        Authorization: `token ${creds.api_key}:${creds.api_secret}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`ERPNext ${path} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private static mapStatus(erpStatus: string): NormalizedInvoice["status"] {
    switch (erpStatus) {
      case "Draft":
        return "draft";
      case "Submitted":
      case "Unpaid":
        return "sent";
      case "Overdue":
        return "overdue";
      case "Partly Paid":
        return "partially_paid";
      case "Paid":
        return "paid";
      case "Cancelled":
        return "cancelled";
      default:
        return "sent";
    }
  }

  async listInvoices(
    creds: ModuleCredentials,
    filter: { status?: NormalizedInvoice["status"] },
  ): Promise<NormalizedInvoice[]> {
    if (this.mockMode) {
      const all = [MOCK_INVOICE];
      return filter.status ? all.filter((i) => i.status === filter.status) : all;
    }
    // Frappe list API: filters as JSON, fields explicit.
    const filters =
      filter.status === "overdue" ? encodeURIComponent(JSON.stringify([["status", "=", "Overdue"]])) : "";
    const fields = encodeURIComponent(
      JSON.stringify(["name", "customer", "status", "outstanding_amount", "currency", "due_date"]),
    );
    const data = await this.frappeGet<{ data: FrappeSalesInvoice[] }>(
      creds,
      `/api/resource/Sales Invoice?fields=${fields}${filters ? `&filters=${filters}` : ""}`,
    );
    return data.data.map(ErpNextAdapter.toNormalizedInvoice);
  }

  async getInvoice(creds: ModuleCredentials, invoiceId: string): Promise<NormalizedInvoice | null> {
    if (this.mockMode) {
      return invoiceId === MOCK_INVOICE.invoice_id ? MOCK_INVOICE : null;
    }
    try {
      const data = await this.frappeGet<{ data: FrappeSalesInvoice }>(
        creds,
        `/api/resource/Sales Invoice/${encodeURIComponent(invoiceId)}`,
      );
      return ErpNextAdapter.toNormalizedInvoice(data.data);
    } catch {
      return null;
    }
  }

  async getCustomer(creds: ModuleCredentials, customerId: string): Promise<NormalizedCustomer | null> {
    if (this.mockMode) {
      return customerId === MOCK_CUSTOMER.customer_id ? MOCK_CUSTOMER : null;
    }
    try {
      const data = await this.frappeGet<{
        data: { name: string; customer_name: string; email_id?: string; mobile_no?: string };
      }>(creds, `/api/resource/Customer/${encodeURIComponent(customerId)}`);
      return {
        customer_id: data.data.name,
        name: data.data.customer_name,
        email: data.data.email_id,
        phone: data.data.mobile_no,
      };
    } catch {
      return null;
    }
  }

  async getPaymentHistory(creds: ModuleCredentials, customerId: string): Promise<PaymentHistoryEntry[]> {
    if (this.mockMode) {
      return customerId === MOCK_CUSTOMER.customer_id ? MOCK_PAYMENT_HISTORY : [];
    }
    const filters = encodeURIComponent(
      JSON.stringify([
        ["party", "=", customerId],
        ["docstatus", "=", 1],
      ]),
    );
    const fields = encodeURIComponent(
      JSON.stringify(["name", "paid_amount", "paid_to_account_currency", "posting_date"]),
    );
    const data = await this.frappeGet<{
      data: { name: string; paid_amount: number; paid_to_account_currency: string; posting_date: string }[];
    }>(creds, `/api/resource/Payment Entry?filters=${filters}&fields=${fields}`);
    return data.data.map((p) => ({
      invoice_id: p.name,
      amount_paid: p.paid_amount,
      currency: p.paid_to_account_currency,
      paid_at: p.posting_date,
    }));
  }

  async sendReminder(_creds: ModuleCredentials, req: ReminderRequest): Promise<{ delivery_ref: string }> {
    // Phase 0: no real email/WhatsApp provider yet. Log-and-ack completes the
    // round trip; Phase 1 swaps this for a delivery integration.
    console.log(
      `[reminder:${this.mockMode ? "mock" : "live"}] ${req.channel} → customer ${req.customer_id} re invoice ${req.invoice_id}: ${req.message}`,
    );
    return { delivery_ref: `dlv_${crypto.randomUUID()}` };
  }

  normalizeWebhook(tenantId: string, body: unknown): EventEnvelope | null {
    // ERPNext webhooks post the doc as JSON; we key off doctype + status.
    const doc = body as Partial<FrappeSalesInvoice> & { doctype?: string };
    if (doc?.doctype !== "Sales Invoice" || !doc.name || !doc.customer) {
      return null;
    }
    if (doc.status === "Overdue") {
      const dueDate = doc.due_date ? new Date(doc.due_date) : new Date();
      const daysOverdue = Math.max(0, Math.floor((Date.now() - dueDate.getTime()) / 86_400_000));
      return makeEnvelope({
        event_type: "invoice.overdue",
        source_module: "finance",
        tenant_id: tenantId,
        payload: {
          invoice_id: doc.name,
          customer_id: doc.customer,
          amount_due: doc.outstanding_amount ?? 0,
          currency: doc.currency ?? "USD",
          days_overdue: daysOverdue,
        },
      });
    }
    if (doc.status === "Paid") {
      return makeEnvelope({
        event_type: "payment.received",
        source_module: "finance",
        tenant_id: tenantId,
        payload: {
          invoice_id: doc.name,
          customer_id: doc.customer,
          amount_paid: doc.grand_total ?? 0,
          currency: doc.currency ?? "USD",
        },
      });
    }
    return null;
  }

  private static toNormalizedInvoice(inv: FrappeSalesInvoice): NormalizedInvoice {
    return {
      invoice_id: inv.name,
      customer_id: inv.customer,
      status: ErpNextAdapter.mapStatus(inv.status),
      amount_due: inv.outstanding_amount,
      currency: inv.currency,
      due_date: inv.due_date,
    };
  }
}

interface FrappeSalesInvoice {
  name: string;
  customer: string;
  status: string;
  outstanding_amount: number;
  grand_total?: number;
  currency: string;
  due_date: string;
}

const MOCK_INVOICE: NormalizedInvoice = {
  invoice_id: "inv_789",
  customer_id: "cust_456",
  status: "overdue",
  amount_due: 4500,
  currency: "MYR",
  due_date: "2026-06-26",
};

const MOCK_CUSTOMER: NormalizedCustomer = {
  customer_id: "cust_456",
  name: "Syarikat Contoh Sdn Bhd",
  email: "accounts@contoh.example.com",
  phone: "+60123456789",
};

const MOCK_PAYMENT_HISTORY: PaymentHistoryEntry[] = [
  { invoice_id: "inv_701", amount_paid: 3200, currency: "MYR", paid_at: "2026-05-02T04:10:00Z" },
];
