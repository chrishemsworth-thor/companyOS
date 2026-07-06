import { z } from "zod";

/**
 * payment.received.v2 — v1's float amount_paid becomes integer cents.
 * payment_id is optional because externally sourced payments (webhook
 * translation, retired with the adapter layer) have no native payment row.
 */
export const paymentReceivedV2 = z.object({
  payment_id: z.string().optional(),
  invoice_id: z.string(),
  customer_id: z.string(),
  amount_paid_cents: z.number().int().positive(),
  currency: z.string().length(3),
});
export type PaymentReceivedV2 = z.infer<typeof paymentReceivedV2>;
