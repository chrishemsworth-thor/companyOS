import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import {
  createCustomer,
  getCustomer,
  getPaymentHistory,
  listActivities,
  listCustomers,
} from "../../modules/crm/service";

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
});

export const customers = new Hono<AuthedEnv>();

customers.get("/", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ customers: await listCustomers(c.env.DB, tenant.tenant_id) });
});

customers.post("/", zValidator("json", createBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const customer = await createCustomer(c.env, tenant.tenant_id, c.req.valid("json"));
  return c.json(customer, 201);
});

customers.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const customer = await getCustomer(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!customer) return c.json({ error: "customer not found" }, 404);
  return c.json(customer);
});

/** Native query over payments/payment_applications. */
customers.get("/:id/payment-history", async (c) => {
  const tenant = c.get("tenant");
  const history = await getPaymentHistory(c.env.DB, tenant.tenant_id, c.req.param("id"));
  return c.json({ payments: history });
});

customers.get("/:id/activities", async (c) => {
  const tenant = c.get("tenant");
  const activities = await listActivities(c.env.DB, tenant.tenant_id, c.req.param("id"));
  return c.json({ activities });
});
