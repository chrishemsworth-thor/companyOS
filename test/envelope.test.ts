import { describe, it, expect } from "vitest";
import { eventEnvelopeSchema, makeEnvelope } from "../src/schemas/envelope";
import { validatePayload } from "../src/schemas/events/registry";

const validOverduePayload = {
  invoice_id: "inv_789",
  customer_id: "cust_456",
  amount_due: 4500,
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
});
