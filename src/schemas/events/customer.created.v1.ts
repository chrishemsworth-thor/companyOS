import { z } from "zod";

/** customer.created.v1 — a new customer record in the native CRM. */
export const customerCreatedV1 = z.object({
  customer_id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
});
export type CustomerCreatedV1 = z.infer<typeof customerCreatedV1>;
