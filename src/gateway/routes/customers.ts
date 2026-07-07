import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { pageQuerySchema } from "../pagination";
import { crmErrorResponse } from "./deals";
import {
  createCustomer,
  getCustomer,
  getPaymentHistory,
  listActivities,
  listCustomers,
  updateCustomer,
} from "../../modules/crm/service";
import type { CollectionsAgent } from "../../agents/collections";

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
});

const patchBodySchema = createBodySchema
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

export const customers = new Hono<AuthedEnv>();

customers.get("/", zValidator("query", pageQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { cursor, limit } = c.req.valid("query");
  return c.json(await listCustomers(c.env.DB, tenant.tenant_id, { cursor, limit }));
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

customers.patch("/:id", zValidator("json", patchBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const customer = await updateCustomer(
      c.env.DB,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    return c.json(customer);
  } catch (err) {
    return crmErrorResponse(c, err);
  }
});

/**
 * Live collections-agent snapshot for this customer. Reads DO storage only
 * (idFromName/get are lazy and snapshot() never writes), so probing a
 * customer the agent has never touched returns `agent_state: null` without
 * creating state.
 */
customers.get("/:id/agent", async (c) => {
  const tenant = c.get("tenant");
  const id = c.env.COLLECTIONS_AGENT.idFromName(`${tenant.tenant_id}:${c.req.param("id")}`);
  const stub = c.env.COLLECTIONS_AGENT.get(id) as unknown as CollectionsAgent;
  const state = await stub.snapshot();
  if (!state) return c.json({ agent_state: null });
  const { tenant_id: _tenantId, ...agentState } = state;
  return c.json({ agent_state: agentState });
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
