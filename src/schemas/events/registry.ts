import type { z } from "zod";
import { invoiceOverdueV1 } from "./invoice.overdue.v1";
import { paymentReceivedV1 } from "./payment.received.v1";

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
  "invoice.overdue": invoiceOverdueV1,
  "payment.received": paymentReceivedV1,
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
