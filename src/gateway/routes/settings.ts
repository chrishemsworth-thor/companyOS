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
} from "../../modules/quotes/settings";
import { quoteTemplateConfigSchema } from "../../modules/quotes/branding";
import {
  AgentSettingsError,
  DEFAULT_TIME_ZONE,
  getAgentSettings,
  isValidTimeZone,
  upsertAgentSettings,
} from "../../agents/guardrails";

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
  /**
   * The tenant's local time (PRD-002, conflict C6). Validated against ICU
   * rather than a hardcoded list: the zone database changes, our list would not,
   * and `Intl.DateTimeFormat` is the same authority the guardrail resolves with.
   */
  timezone: z
    .string()
    .max(64)
    .refine(isValidTimeZone, "must be an IANA time zone name, e.g. Asia/Kuala_Lumpur")
    .default(DEFAULT_TIME_ZONE),
});

/**
 * The agent guardrail policy (PRD-002 P0). Every bound here is one PRD-002
 * calls tenant-configurable; the ones it does not are absent on purpose — a
 * field on this form is a promise that a tenant may change it.
 *
 * A partial body: an omitted field keeps its current value, so a console form
 * that predates a new bound cannot silently reset it.
 */
const agentSettingsSchema = z
  .object({
    enabled: z.boolean(),
    contact_window_start_hour: z.number().int().min(0).max(23),
    contact_window_end_hour: z.number().int().min(1).max(24),
    suppress_weekends: z.boolean(),
    suppress_holidays: z.boolean(),
    max_reminders_per_invoice: z.number().int().min(1).max(50),
    // PRD-002's blocking question, answered at 60 (Malaysian SME norms run
    // 60-90 days). The floor is 1, not 0: escalating on the due date is not a
    // policy, and the "and >= 2 prior reminders" half of the gate is not
    // configurable at all.
    escalation_threshold_days: z.number().int().min(1).max(365),
    contact_cooldown_hours: z.number().int().min(1).max(720),
    max_message_chars: z.number().int().min(200).max(10_000),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

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

/**
 * The resolved guardrail policy, including the defaults a tenant who has never
 * saved settings is running under — `configured: false` says which case it is.
 * A read is on the settings axis, so a finance or support user can see what the
 * agent is allowed to do without being able to change it.
 */
settings.get("/agents", async (c) => {
  const tenant = c.get("tenant");
  return c.json(await getAgentSettings(c.env.DB, tenant.tenant_id));
});

/**
 * Raised to `agents:write` rather than left on the router's `settings:write`.
 * Both resolve to {admin, operator} today, so this records intent rather than
 * changing behaviour: this endpoint carries PRD-002's kill switch, and if the
 * settings axis ever widens it must not take the kill switch with it.
 */
settings.put(
  "/agents",
  requireCapability("agents:write"),
  zValidator("json", agentSettingsSchema),
  async (c) => {
    const tenant = c.get("tenant");
    try {
      return c.json(await upsertAgentSettings(c.env.DB, tenant.tenant_id, c.req.valid("json")));
    } catch (err) {
      if (err instanceof AgentSettingsError) {
        return c.json({ error: err.message, code: err.code }, err.httpStatus);
      }
      throw err;
    }
  },
);

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
