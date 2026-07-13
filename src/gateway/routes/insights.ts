import { Hono } from "hono";
import type { AuthedEnv } from "../middleware/auth";
import {
  arAging,
  dashboardSummary,
  pipelineByStage,
  revenueByMonth,
  ticketInsights,
} from "../../modules/insights/service";

/**
 * Read-only cross-module aggregates for the operator dashboard. Available to
 * both humans (session) and agents (API key) via the shared authenticate()
 * guard — but built for the human console, which otherwise fans out over
 * several list endpoints and sums client-side.
 */
export const insights = new Hono<AuthedEnv>();

insights.get("/summary", async (c) => {
  const tenant = c.get("tenant");
  return c.json(await dashboardSummary(c.env.DB, tenant.tenant_id));
});

insights.get("/ar-aging", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ buckets: await arAging(c.env.DB, tenant.tenant_id) });
});

insights.get("/revenue", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ points: await revenueByMonth(c.env.DB, tenant.tenant_id) });
});

insights.get("/pipeline", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ stages: await pipelineByStage(c.env.DB, tenant.tenant_id) });
});

insights.get("/tickets", async (c) => {
  const tenant = c.get("tenant");
  return c.json(await ticketInsights(c.env.DB, tenant.tenant_id));
});
