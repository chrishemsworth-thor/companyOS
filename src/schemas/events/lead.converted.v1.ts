import { z } from "zod";

/**
 * lead.converted.v1 — a qualified lead became a customer. contact_id is set
 * when the lead named a company (the person becomes a contact there);
 * deal_id when the caller asked for a deal alongside.
 */
export const leadConvertedV1 = z.object({
  lead_id: z.string(),
  customer_id: z.string(),
  contact_id: z.string().optional(),
  deal_id: z.string().optional(),
});
export type LeadConvertedV1 = z.infer<typeof leadConvertedV1>;
