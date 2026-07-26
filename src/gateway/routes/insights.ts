import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import {
  arAging,
  dashboardSummary,
  pipelineByStage,
  profitability,
  revenueByMonth,
  ticketInsights,
} from "../../modules/insights/service";

const profitabilityQuerySchema = z.object({
  group_by: z.enum(["project", "customer", "department"]).default("project"),
});

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

/**
 * Profitability by ledger dimension. Read-only SQL over the dimensioned ledger
 * — the payoff for PRD-001a, and the rollup no assembled stack can produce
 * without an integration.
 */
insights.get("/profitability", zValidator("query", profitabilityQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { group_by } = c.req.valid("query");
  return c.json({
    group_by,
    rows: await profitability(c.env.DB, tenant.tenant_id, group_by),
  });
});

insights.get("/tickets", async (c) => {
  const tenant = c.get("tenant");
  return c.json(await ticketInsights(c.env.DB, tenant.tenant_id));
});
