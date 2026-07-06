import { describe, it, expect } from "vitest";
import { eventEnvelopeSchema, makeEnvelope } from "../src/schemas/envelope";
import { validatePayload } from "../src/schemas/events/registry";

const validOverduePayload = {
  invoice_id: "inv_789",
  customer_id: "cust_456",
  amount_due_cents: 450_000,
  currency: "MYR",
  days_overdue: 9,
};

describe("event envelope", () => {
  it("makeEnvelope produces a schema-valid envelope with generated ids", () => {
    const envelope = makeEnvelope({
      event_type: "invoice.overdue",
      source_module: "finance",
      tenant_id: "biz_abc123",
      payload: validOverduePayload,
    });
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.event_id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(envelope.trace_id).toMatch(/^trc_/);
  });

  it("rejects malformed event_type and tenant_id", () => {
    const bad = makeEnvelope({
      event_type: "invoice.overdue",
      source_module: "finance",
      tenant_id: "biz_abc123",
      payload: validOverduePayload,
    });
    expect(
      eventEnvelopeSchema.safeParse({ ...bad, event_type: "InvoiceOverdue" }).success,
    ).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...bad, tenant_id: "abc123" }).success).toBe(false);
  });
});

describe("event registry", () => {
  it("accepts a valid invoice.overdue payload", () => {
    expect(validatePayload("invoice.overdue", validOverduePayload)).toEqual({ ok: true });
  });

  it("rejects unknown event types", () => {
    const result = validatePayload("invoice.exploded", {});
    expect(result.ok).toBe(false);
  });

  it("rejects payloads that fail the versioned schema", () => {
    const result = validatePayload("invoice.overdue", { invoice_id: "inv_789" });
    expect(result.ok).toBe(false);
  });

  const financeEventSamples: Record<string, Record<string, unknown>> = {
    "invoice.created": {
      invoice_id: "inv_1",
      customer_id: "cust_1",
      total_cents: 10_000,
      currency: "MYR",
      due_date: "2026-08-01",
    },
    "invoice.sent": {
      invoice_id: "inv_1",
      customer_id: "cust_1",
      sent_at: "2026-07-06T00:00:00.000Z",
    },
    "payment.received": {
      payment_id: "pay_1",
      invoice_id: "inv_1",
      customer_id: "cust_1",
      amount_paid_cents: 10_000,
      currency: "MYR",
    },
    "payment.partial": {
      payment_id: "pay_1",
      invoice_id: "inv_1",
      customer_id: "cust_1",
      amount_paid_cents: 4_000,
      remaining_cents: 6_000,
      currency: "MYR",
    },
  };

  it.each(Object.entries(financeEventSamples))(
    "accepts a valid %s payload and rejects an empty one",
    (eventType, payload) => {
      expect(validatePayload(eventType, payload)).toEqual({ ok: true });
      expect(validatePayload(eventType, {}).ok).toBe(false);
    },
  );
});
