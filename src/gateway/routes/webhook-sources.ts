import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { BuildError } from "../../modules/build/service";
import { createWebhookSource, disableSource, listSources } from "../../webhooks/sources";
import { deriveSourceSecret } from "../../webhooks/verify";

/**
 * Tenant-scoped provisioning for inbound webhook sources (JIRA/GitHub/
 * Bitbucket → Build). Creating a source returns the delivery URL and its
 * derived signing secret exactly once — neither is stored, so a lost secret
 * means disabling the source and creating a new one.
 */
export const webhookSources = new Hono<AuthedEnv>();

const createSourceSchema = z.object({
  provider: z.enum(["jira", "github", "bitbucket"]),
  project_id: z.string().startsWith("prj_"),
  external_project_key: z.string().min(1).max(300).optional(),
});

webhookSources.post("/", zValidator("json", createSourceSchema), async (c) => {
  const tenant = c.get("tenant");
  const master = c.env.WEBHOOK_MASTER_SECRET;
  if (!master) return c.json({ error: "webhook ingestion is not configured" }, 503);

  try {
    const source = await createWebhookSource(c.env.DB, tenant.tenant_id, c.req.valid("json"));
    const secret = await deriveSourceSecret(master, source.source_id);
    const base = new URL(c.req.url).origin;
    // JIRA Cloud can't sign request bodies, so its secret rides in the URL.
    const url =
      source.provider === "jira"
        ? `${base}/webhooks/jira/${source.source_id}?secret=${secret}`
        : `${base}/webhooks/${source.provider}/${source.source_id}`;
    return c.json({ ...source, url, secret }, 201);
  } catch (err) {
    if (err instanceof BuildError) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus);
    }
    throw err;
  }
});

webhookSources.get("/", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ webhook_sources: await listSources(c.env.DB, tenant.tenant_id) });
});

webhookSources.delete("/:id", async (c) => {
  const tenant = c.get("tenant");
  const disabled = await disableSource(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!disabled) return c.json({ error: "webhook source not found" }, 404);
  return c.json({ status: "disabled" });
});
