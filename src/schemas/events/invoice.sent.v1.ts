import { z } from "zod";

/** invoice.sent.v1 — emitted when an invoice is delivered to the customer. */
export const invoiceSentV1 = z.object({
  invoice_id: z.string(),
  customer_id: z.string(),
  sent_at: z.string().datetime(),
});
export type InvoiceSentV1 = z.infer<typeof invoiceSentV1>;
