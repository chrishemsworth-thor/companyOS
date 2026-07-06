import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { recordPayment } from "../../modules/finance/service";
import { financeErrorResponse } from "./invoices";

const recordBodySchema = z.object({
  customer_id: z.string().min(1),
  amount_cents: z.number().int().positive(),
  currency: z.string().length(3),
  method: z.string().max(50).optional(),
  received_at: z.string().datetime().optional(),
  applications: z
    .array(
      z.object({
        invoice_id: z.string().min(1),
        applied_cents: z.number().int().positive(),
      }),
    )
    .min(1),
});

export const payments = new Hono<AuthedEnv>();

/** Record a payment and settle invoices. Overpayment / mismatch → 422, nothing written. */
payments.post("/", zValidator("json", recordBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const result = await recordPayment(c.env, tenant.tenant_id, c.req.valid("json"));
    return c.json(result, 201);
  } catch (err) {
    return financeErrorResponse(c, err);
  }
});
