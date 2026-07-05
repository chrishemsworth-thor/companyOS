import { z } from "zod";

/**
 * payment.received.v1 — emitted when a payment is recorded against an invoice.
 * Closes the collections loop for the CollectionsAgent.
 */
export const paymentReceivedV1 = z.object({
  invoice_id: z.string(),
  customer_id: z.string(),
  amount_paid: z.number().positive(),
  currency: z.string().length(3),
});
export type PaymentReceivedV1 = z.infer<typeof paymentReceivedV1>;
