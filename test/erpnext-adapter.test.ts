import { describe, it, expect } from "vitest";
import { ErpNextAdapter } from "../src/gateway/adapters/erpnext";
import { eventEnvelopeSchema } from "../src/schemas/envelope";
import { validatePayload } from "../src/schemas/events/registry";

const adapter = new ErpNextAdapter(true);

// Shape of an ERPNext Sales Invoice webhook payload (subset we care about).
const erpnextOverdueWebhook = {
  doctype: "Sales Invoice",
  name: "inv_789",
  customer: "cust_456",
  status: "Overdue",
  outstanding_amount: 4500,
  currency: "MYR",
  due_date: "2026-06-26",
};

describe("ErpNextAdapter.normalizeWebhook", () => {
  it("translates an Overdue Sales Invoice webhook into a valid invoice.overdue event", () => {
    const envelope = adapter.normalizeWebhook("biz_abc123", erpnextOverdueWebhook);
    expect(envelope).not.toBeNull();
    expect(envelope!.event_type).toBe("invoice.overdue");
    expect(envelope!.source_module).toBe("finance");
    expect(envelope!.tenant_id).toBe("biz_abc123");
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(validatePayload(envelope!.event_type, envelope!.payload)).toEqual({ ok: true });
    expect(envelope!.payload).toMatchObject({
      invoice_id: "inv_789",
      customer_id: "cust_456",
      amount_due_cents: 450_000,
      currency: "MYR",
    });
  });

  it("translates a Paid Sales Invoice webhook into payment.received", () => {
    const envelope = adapter.normalizeWebhook("biz_abc123", {
      ...erpnextOverdueWebhook,
      status: "Paid",
      grand_total: 4500,
    });
    expect(envelope!.event_type).toBe("payment.received");
    expect(validatePayload(envelope!.event_type, envelope!.payload)).toEqual({ ok: true });
  });

  it("ignores doctypes and statuses we don't track", () => {
    expect(adapter.normalizeWebhook("biz_abc123", { doctype: "ToDo", name: "x" })).toBeNull();
    expect(
      adapter.normalizeWebhook("biz_abc123", { ...erpnextOverdueWebhook, status: "Draft" }),
    ).toBeNull();
  });
});

describe("ErpNextAdapter mock mode", () => {
  const creds = { base_url: "https://mock.invalid", api_key: "k", api_secret: "s" };

  it("lists overdue invoices without any network call", async () => {
    const invoices = await adapter.listInvoices(creds, { status: "overdue" });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.invoice_id).toBe("inv_789");
  });

  it("returns null for unknown invoices", async () => {
    expect(await adapter.getInvoice(creds, "inv_nope")).toBeNull();
  });

  it("sends a mock reminder and returns a delivery ref", async () => {
    const result = await adapter.sendReminder(creds, {
      invoice_id: "inv_789",
      customer_id: "cust_456",
      channel: "email",
      message: "test",
    });
    expect(result.delivery_ref).toMatch(/^dlv_/);
  });
});
