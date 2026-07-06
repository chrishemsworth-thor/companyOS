import type { z } from "zod";
import { invoiceCreatedV1 } from "./invoice.created.v1";
import { invoiceSentV1 } from "./invoice.sent.v1";
import { invoiceOverdueV2 } from "./invoice.overdue.v2";
import { paymentReceivedV2 } from "./payment.received.v2";
import { paymentPartialV1 } from "./payment.partial.v1";

/**
 * event_type → current payload schema. The queue consumer refuses events whose
 * type is unknown or whose payload fails validation; those retry and then land
 * in the dead-letter queue rather than reaching agents malformed.
 *
 * Convention: each entry points at the latest version of that event's schema
 * (`invoice.overdue` → invoice.overdue.v1 today). When a payload changes
 * incompatibly, add a v2 file and bump the mapping here.
 */
export const eventRegistry: Record<string, z.ZodTypeAny> = {
  "invoice.created": invoiceCreatedV1,
  "invoice.sent": invoiceSentV1,
  "invoice.overdue": invoiceOverdueV2,
  "payment.received": paymentReceivedV2,
  "payment.partial": paymentPartialV1,
};

export function validatePayload(
  eventType: string,
  payload: unknown,
): { ok: true } | { ok: false; error: string } {
  const schema = eventRegistry[eventType];
  if (!schema) {
    return { ok: false, error: `unknown event_type: ${eventType}` };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true };
}
