import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { getDeliveryProvider } from "../../delivery/console";
import {
  createInvoice,
  FinanceError,
  getInvoice,
  getInvoiceLines,
  listInvoices,
  sendInvoice,
} from "../../modules/finance/service";
import type { Invoice } from "../../modules/finance/types";

const listQuerySchema = z.object({
  status: z
    .enum(["draft", "sent", "overdue", "partially_paid", "paid", "cancelled"])
    .optional(),
});

const createBodySchema = z.object({
  customer_id: z.string().min(1),
  currency: z.string().length(3),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be YYYY-MM-DD"),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().int().positive().default(1),
        unit_cents: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

const reminderBodySchema = z.object({
  channel: z.enum(["email", "whatsapp"]).default("email"),
  // Optional override; when absent the agent-side template is used.
  message: z.string().max(2000).optional(),
});

export const invoices = new Hono<AuthedEnv>();

export function financeErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof FinanceError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

invoices.get("/", zValidator("query", listQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { status } = c.req.valid("query");
  const result = await listInvoices(c.env.DB, tenant.tenant_id, { status });
  return c.json({ invoices: result });
});

invoices.post("/", zValidator("json", createBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const invoice = await createInvoice(c.env, tenant.tenant_id, c.req.valid("json"));
    return c.json(invoice, 201);
  } catch (err) {
    return financeErrorResponse(c, err);
  }
});

invoices.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const invoice = await getInvoice(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!invoice) return c.json({ error: "invoice not found" }, 404);
  const lines = await getInvoiceLines(c.env.DB, tenant.tenant_id, c.req.param("id"));
  return c.json({ ...invoice, lines });
});

invoices.post("/:id/send", async (c) => {
  const tenant = c.get("tenant");
  try {
    const invoice = await sendInvoice(c.env, tenant.tenant_id, c.req.param("id"));
    return c.json(invoice);
  } catch (err) {
    return financeErrorResponse(c, err);
  }
});

/** Trigger an agent-composed nudge, delivered through the DeliveryProvider port. */
invoices.post("/:id/reminder", zValidator("json", reminderBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const body = c.req.valid("json");

  const invoice = await getInvoice(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!invoice) return c.json({ error: "invoice not found" }, 404);

  const { delivery_ref } = await getDeliveryProvider().send({
    invoice_id: invoice.invoice_id,
    customer_id: invoice.customer_id,
    channel: body.channel,
    message: body.message ?? defaultReminderMessage(invoice),
  });
  return c.json({ status: "sent", delivery_ref }, 202);
});

export function defaultReminderMessage(invoice: Invoice): string {
  return `Friendly reminder: invoice ${invoice.invoice_id} for ${invoice.currency} ${(invoice.amount_due_cents / 100).toFixed(2)} was due on ${invoice.due_date}. Please arrange payment at your earliest convenience.`;
}
