import { z } from "zod";

/** invoice.created.v1 — emitted when an invoice is issued natively. Money in integer cents. */
export const invoiceCreatedV1 = z.object({
  invoice_id: z.string(),
  customer_id: z.string(),
  total_cents: z.number().int().positive(),
  currency: z.string().length(3),
  due_date: z.string(),
});
export type InvoiceCreatedV1 = z.infer<typeof invoiceCreatedV1>;
