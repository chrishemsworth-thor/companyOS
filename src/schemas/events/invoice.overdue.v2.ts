import { z } from "zod";

/**
 * invoice.overdue.v2 — v1's float amount_due becomes integer cents, matching
 * the native finance module. Emitted by the daily overdue sweep.
 */
export const invoiceOverdueV2 = z.object({
  invoice_id: z.string(),
  customer_id: z.string(),
  amount_due_cents: z.number().int().positive(),
  currency: z.string().length(3),
  days_overdue: z.number().int().nonnegative(),
});
export type InvoiceOverdueV2 = z.infer<typeof invoiceOverdueV2>;
