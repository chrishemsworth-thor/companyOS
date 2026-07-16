import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import {
  getCompanyProfile,
  getQuoteBranding,
  upsertCompanyProfile,
  upsertQuoteBranding,
} from "../../modules/quotes/settings";
import { quoteTemplateConfigSchema } from "../../modules/quotes/branding";

/**
 * Per-tenant settings that back the quote document: the seller "From" identity
 * and the per-company quote design. These are the surfaces behind the operator
 * console's Company Profile and Quote Branding pages.
 */
export const settings = new Hono<AuthedEnv>();

const nullableStr = (max: number) => z.string().max(max).nullish();

const companyProfileSchema = z.object({
  legal_name: z.string().min(1).max(200),
  reg_no: nullableStr(80),
  tax_no: nullableStr(80),
  address_line1: nullableStr(200),
  address_line2: nullableStr(200),
  city: nullableStr(100),
  state: nullableStr(100),
  postcode: nullableStr(20),
  country: nullableStr(80),
  phone: nullableStr(50),
  email: z.string().email().max(200).nullish(),
  website: nullableStr(200),
  default_prepared_by: nullableStr(200),
});

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const quoteBrandingSchema = z.object({
  logo_url: z.string().url().max(2000).nullish(),
  primary_color: z.string().regex(HEX_COLOR, "must be a hex colour").optional(),
  accent_color: z.string().regex(HEX_COLOR, "must be a hex colour").optional(),
  font_family: z.string().max(200).optional(),
  // Accept a partial config; the service re-validates/defaults through the full schema.
  template_config: quoteTemplateConfigSchema.partial().optional(),
});

settings.get("/company-profile", async (c) => {
  const tenant = c.get("tenant");
  const profile = await getCompanyProfile(c.env.DB, tenant.tenant_id);
  return c.json({ company_profile: profile });
});

settings.put("/company-profile", zValidator("json", companyProfileSchema), async (c) => {
  const tenant = c.get("tenant");
  const profile = await upsertCompanyProfile(c.env.DB, tenant.tenant_id, c.req.valid("json"));
  return c.json(profile);
});

settings.get("/quote-branding", async (c) => {
  const tenant = c.get("tenant");
  return c.json(await getQuoteBranding(c.env.DB, tenant.tenant_id));
});

settings.put("/quote-branding", zValidator("json", quoteBrandingSchema), async (c) => {
  const tenant = c.get("tenant");
  const branding = await upsertQuoteBranding(c.env.DB, tenant.tenant_id, c.req.valid("json"));
  return c.json(branding);
});
