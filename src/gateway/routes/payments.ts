import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { FinanceError, recordPayment } from "../../modules/finance/service";
import { IdempotencyConflict, withIdempotency } from "../idempotency";

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

/**
 * Record a payment and settle invoices. Overpayment / mismatch → 422,
 * nothing written. Honors an `Idempotency-Key` header — a retry with the
 * same key and body replays the original response rather than recording
 * the payment twice, the worst outcome an agent retry could cause here.
 */
payments.post("/", zValidator("json", recordBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const body = c.req.valid("json");
  try {
    const { status, body: responseBody } = await withIdempotency<unknown>(
      c.env.DB,
      tenant.tenant_id,
      "payments.create",
      c.req.header("Idempotency-Key"),
      body,
      async () => {
        try {
          const result = await recordPayment(c.env, tenant.tenant_id, body);
          return { status: 201, body: result };
        } catch (err) {
          if (err instanceof FinanceError) {
            return { status: err.httpStatus, body: { error: err.message, code: err.code } };
          }
          throw err;
        }
      },
    );
    return c.json(responseBody, status);
  } catch (err) {
    if (err instanceof IdempotencyConflict) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus);
    }
    throw err;
  }
});
