import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { logActivity } from "../../modules/crm/service";

const logBodySchema = z.object({
  customer_id: z.string().min(1),
  deal_id: z.string().optional(),
  kind: z.enum(["note", "call", "email", "meeting", "reminder_sent"]),
  body: z.string().max(5000).optional(),
  occurred_at: z.string().datetime().optional(),
});

export const activities = new Hono<AuthedEnv>();

activities.post("/", zValidator("json", logBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const activity = await logActivity(c.env, tenant.tenant_id, c.req.valid("json"));
  return c.json(activity, 201);
});
