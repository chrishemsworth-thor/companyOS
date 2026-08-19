import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireCapability } from "../middleware/capability";
import {
  getCompanyProfile,
  getQuoteBranding,
  upsertCompanyProfile,
  upsertQuoteBranding,
  QuoteBrandingError,
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
  base_currency: z
    .string()
    .length(3)
    .regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO 4217 code")
    .transform((v) => v.toUpperCase())
    .default("MYR"),
  // PRD-003's tenant-level default behind a customer's payment_terms_days.
  // 0 is legitimate (due on issue); the upper bound is a typo guard.
  default_payment_terms_days: z.number().int().min(0).max(365).optional(),
});

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const quoteBrandingSchema = z.object({
  logo_url: z.string().url().max(2000).nullish(),
  // A file uploaded through POST /v1/files with purpose=quote_logo. Validated
  // against the caller's tenant and that purpose in the service — see
  // assertUsableLogo — so a wrong id is a 422 here rather than a broken image
  // on a document already in front of a customer.
  logo_file_id: z.string().max(64).nullish(),
  primary_color: z.string().regex(HEX_COLOR, "must be a hex colour").optional(),
  accent_color: z.string().regex(HEX_COLOR, "must be a hex colour").optional(),
  font_family: z.string().max(200).optional(),
  footer_text: z.string().max(5000).nullish(),
  // PRD-004 P1: quotes at or above this grand total need internal sign-off
  // before they can be sent. Null (or absent) means no gate.
  sign_off_threshold_cents: z.number().int().nonnegative().nullish(),
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
  try {
    const branding = await upsertQuoteBranding(c.env.DB, tenant.tenant_id, c.req.valid("json"));
    return c.json(branding);
  } catch (err) {
    if (err instanceof QuoteBrandingError) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus);
    }
    throw err;
  }
});

// Marks the first-run onboarding journey as done (finished or dismissed) so
// the console stops redirecting into /onboarding. Admin-only: onboarding is
// the company admin's flow, and this is a tenant-level, one-way switch.
// Idempotent — completing twice keeps the original timestamp.
settings.post("/onboarding/complete", requireCapability("admin:write"), async (c) => {
  const tenant = c.get("tenant");
  await c.env.DB.prepare(
    "UPDATE tenants SET onboarded_at = COALESCE(onboarded_at, ?) WHERE tenant_id = ?",
  )
    .bind(new Date().toISOString(), tenant.tenant_id)
    .run();
  const row = await c.env.DB.prepare("SELECT onboarded_at FROM tenants WHERE tenant_id = ?")
    .bind(tenant.tenant_id)
    .first<{ onboarded_at: string }>();
  return c.json({ onboarded_at: row?.onboarded_at ?? null });
});
