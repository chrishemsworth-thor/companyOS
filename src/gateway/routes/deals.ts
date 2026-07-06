import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { pageQuerySchema } from "../pagination";
import {
  changeDealStage,
  createDeal,
  CrmError,
  ensureDefaultStages,
  getDeal,
  listDeals,
  listStages,
} from "../../modules/crm/service";

const createBodySchema = z.object({
  customer_id: z.string().min(1),
  title: z.string().min(1).max(300),
  value_cents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  stage_id: z.string().startsWith("stg_").optional(),
});

const stageBodySchema = z.object({
  stage_id: z.string().startsWith("stg_"),
});

const listQuerySchema = pageQuerySchema.extend({
  status: z.enum(["open", "won", "lost"]).optional(),
});

export function crmErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof CrmError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

export const deals = new Hono<AuthedEnv>();

deals.get("/stages", async (c) => {
  const tenant = c.get("tenant");
  await ensureDefaultStages(c.env.DB, tenant.tenant_id);
  return c.json({ stages: await listStages(c.env.DB, tenant.tenant_id) });
});

deals.get("/", zValidator("query", listQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { status, cursor, limit } = c.req.valid("query");
  return c.json(await listDeals(c.env.DB, tenant.tenant_id, { status, cursor, limit }));
});

deals.post("/", zValidator("json", createBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const deal = await createDeal(c.env, tenant.tenant_id, c.req.valid("json"));
    return c.json(deal, 201);
  } catch (err) {
    return crmErrorResponse(c, err);
  }
});

deals.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const deal = await getDeal(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!deal) return c.json({ error: "deal not found" }, 404);
  return c.json(deal);
});

deals.post("/:id/stage", zValidator("json", stageBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const deal = await changeDealStage(
      c.env,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json").stage_id,
    );
    return c.json(deal);
  } catch (err) {
    return crmErrorResponse(c, err);
  }
});
