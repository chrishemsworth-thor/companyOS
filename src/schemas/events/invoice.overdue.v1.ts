import { z } from "zod";

/**
 * invoice.overdue.v1 — emitted when an invoice's due date has passed unpaid.
 * Versioned so Phase 2/3 can evolve the payload without breaking older agents.
 */
export const invoiceOverdueV1 = z.object({
  invoice_id: z.string(),
  customer_id: z.string(),
  amount_due: z.number().positive(),
  currency: z.string().length(3),
  days_overdue: z.number().int().nonnegative(),
});
export type InvoiceOverdueV1 = z.infer<typeof invoiceOverdueV1>;
