import { z } from "zod";

/**
 * payment.partial.v1 — a payment application that leaves an invoice partly
 * unpaid. Same shape as payment.received.v2 plus remaining_cents.
 */
export const paymentPartialV1 = z.object({
  payment_id: z.string(),
  invoice_id: z.string(),
  customer_id: z.string(),
  amount_paid_cents: z.number().int().positive(),
  remaining_cents: z.number().int().positive(),
  currency: z.string().length(3),
});
export type PaymentPartialV1 = z.infer<typeof paymentPartialV1>;
