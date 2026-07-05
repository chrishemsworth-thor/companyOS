import { Hono } from "hono";
import { ErpNextAdapter } from "../adapters/erpnext";
import { getModuleCredentials, MOCK_CREDENTIALS } from "../middleware/tenant";
import type { AuthedEnv } from "../middleware/auth";

export const customers = new Hono<AuthedEnv>();

async function financeContext(env: AuthedEnv["Bindings"], tenantId: string) {
  const mock = env.MOCK_MODE === "true";
  const adapter = new ErpNextAdapter(mock);
  const creds = mock ? MOCK_CREDENTIALS : await getModuleCredentials(env, tenantId, "finance");
  return { adapter, creds };
}

customers.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const { adapter, creds } = await financeContext(c.env, tenant.tenant_id);
  if (!creds) return c.json({ error: "finance module not connected" }, 409);
  const customer = await adapter.getCustomer(creds, c.req.param("id"));
  if (!customer) return c.json({ error: "customer not found" }, 404);
  return c.json(customer);
});

customers.get("/:id/payment-history", async (c) => {
  const tenant = c.get("tenant");
  const { adapter, creds } = await financeContext(c.env, tenant.tenant_id);
  if (!creds) return c.json({ error: "finance module not connected" }, 409);
  const history = await adapter.getPaymentHistory(creds, c.req.param("id"));
  return c.json({ payments: history });
});
