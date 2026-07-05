import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ErpNextAdapter } from "../adapters/erpnext";
import { getModuleCredentials, MOCK_CREDENTIALS } from "../middleware/tenant";
import type { AuthedEnv } from "../middleware/auth";
import type { NormalizedInvoice } from "../adapters/types";

const listQuerySchema = z.object({
  status: z
    .enum(["draft", "sent", "overdue", "partially_paid", "paid", "cancelled"])
    .optional(),
});

const reminderBodySchema = z.object({
  channel: z.enum(["email", "whatsapp"]).default("email"),
  // Optional override; when absent the agent-side template is used.
  message: z.string().max(2000).optional(),
});

export const invoices = new Hono<AuthedEnv>();

async function financeContext(env: AuthedEnv["Bindings"], tenantId: string) {
  const mock = env.MOCK_MODE === "true";
  const adapter = new ErpNextAdapter(mock);
  const creds = mock ? MOCK_CREDENTIALS : await getModuleCredentials(env, tenantId, "finance");
  return { adapter, creds };
}

invoices.get("/", zValidator("query", listQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { status } = c.req.valid("query");
  const { adapter, creds } = await financeContext(c.env, tenant.tenant_id);
  if (!creds) return c.json({ error: "finance module not connected" }, 409);
  const result = await adapter.listInvoices(creds, { status });
  return c.json({ invoices: result });
});

invoices.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const { adapter, creds } = await financeContext(c.env, tenant.tenant_id);
  if (!creds) return c.json({ error: "finance module not connected" }, 409);
  const invoice = await adapter.getInvoice(creds, c.req.param("id"));
  if (!invoice) return c.json({ error: "invoice not found" }, 404);
  return c.json(invoice);
});

/**
 * Trigger an agent-composed nudge — this is not a raw ERPNext write. The
 * gateway resolves the invoice, then hands delivery to the adapter (Phase 0:
 * templated message; Phase 1: agent-composed).
 */
invoices.post("/:id/reminder", zValidator("json", reminderBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const body = c.req.valid("json");
  const { adapter, creds } = await financeContext(c.env, tenant.tenant_id);
  if (!creds) return c.json({ error: "finance module not connected" }, 409);

  const invoice = await adapter.getInvoice(creds, c.req.param("id"));
  if (!invoice) return c.json({ error: "invoice not found" }, 404);

  const { delivery_ref } = await adapter.sendReminder(creds, {
    invoice_id: invoice.invoice_id,
    customer_id: invoice.customer_id,
    channel: body.channel,
    message: body.message ?? defaultReminderMessage(invoice),
  });
  return c.json({ status: "sent", delivery_ref }, 202);
});

export function defaultReminderMessage(invoice: NormalizedInvoice): string {
  return `Friendly reminder: invoice ${invoice.invoice_id} for ${invoice.currency} ${invoice.amount_due.toFixed(2)} was due on ${invoice.due_date}. Please arrange payment at your earliest convenience.`;
}
