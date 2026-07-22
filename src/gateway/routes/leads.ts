import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { pageQuerySchema } from "../pagination";
import { crmErrorResponse } from "./deals";
import {
  convertLead,
  createLead,
  enrichLead,
  getLead,
  listLeads,
  updateLead,
} from "../../modules/crm/service";

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  company: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(120).optional(),
  source: z.string().max(50).optional(),
  notes: z.string().max(2000).optional(),
});

// status 'converted' is reachable only through POST /:id/convert.
const patchBodySchema = createBodySchema
  .extend({ status: z.enum(["new", "qualified", "lost"]) })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

const convertBodySchema = z.object({
  deal: z
    .object({
      title: z.string().min(1).max(300),
      value_cents: z.number().int().nonnegative(),
      // Optional: when omitted, the company's base currency applies (service-side).
      currency: z.string().length(3).optional(),
      stage_id: z.string().startsWith("stg_").optional(),
    })
    .optional(),
});

const listQuerySchema = pageQuerySchema.extend({
  status: z.enum(["new", "qualified", "converted", "lost"]).optional(),
});

export const leads = new Hono<AuthedEnv>();

leads.get("/", zValidator("query", listQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { status, cursor, limit } = c.req.valid("query");
  return c.json(await listLeads(c.env.DB, tenant.tenant_id, { status, cursor, limit }));
});

leads.post("/", zValidator("json", createBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const lead = await createLead(c.env, tenant.tenant_id, c.req.valid("json"));
  return c.json(lead, 201);
});

leads.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const lead = await getLead(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!lead) return c.json({ error: "lead not found" }, 404);
  return c.json(lead);
});

leads.patch("/:id", zValidator("json", patchBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const lead = await updateLead(c.env.DB, tenant.tenant_id, c.req.param("id"), c.req.valid("json"));
    return c.json(lead);
  } catch (err) {
    return crmErrorResponse(c, err);
  }
});

/** Lead → customer (+ contact, + optional deal). Converted/lost leads → 409. */
leads.post("/:id/convert", zValidator("json", convertBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const result = await convertLead(c.env, tenant.tenant_id, c.req.param("id"), c.req.valid("json"));
    return c.json(result);
  } catch (err) {
    return crmErrorResponse(c, err);
  }
});

/** Fill empty lead fields via the enrichment port (no-op by default). */
leads.post("/:id/enrich", async (c) => {
  const tenant = c.get("tenant");
  try {
    const result = await enrichLead(c.env, tenant.tenant_id, c.req.param("id"));
    return c.json(result);
  } catch (err) {
    return crmErrorResponse(c, err);
  }
});
