import {
  DEFAULT_BRANDING,
  quoteTemplateConfigSchema,
  resolveTemplateConfig,
  type QuoteBranding,
  type QuoteTemplateConfig,
} from "./branding";
import { DEFAULT_PAYMENT_TERMS_DAYS } from "../finance/payment-terms";
import { DEFAULT_TIME_ZONE } from "../../agents/guardrails/zone";
import type { CompanyProfile } from "./types";

/**
 * Per-tenant settings backing the quote document: the seller "From" identity
 * (`company_profile`) and the per-company design (`quote_branding`). Both mirror
 * the `delivery_config` pattern — one row per tenant, "no row => defaults", so
 * the document renderer never depends on a row existing.
 */

const PROFILE_COLUMNS =
  "legal_name, reg_no, tax_no, address_line1, address_line2, city, state, postcode, country, phone, email, website, default_prepared_by, base_currency, default_payment_terms_days, timezone";

/** Company-wide default currency when no profile row exists yet. */
export const DEFAULT_BASE_CURRENCY = "MYR";

export async function getCompanyProfile(
  db: D1Database,
  tenantId: string,
): Promise<CompanyProfile | null> {
  return db
    .prepare(`SELECT ${PROFILE_COLUMNS} FROM company_profile WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<CompanyProfile>();
}

export interface CompanyProfileInput {
  legal_name: string;
  reg_no?: string | null;
  tax_no?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  default_prepared_by?: string | null;
  base_currency?: string;
  /**
   * PRD-003's "(default from tenant settings)" for `payment_terms_days`. The
   * per-customer value wins; this is the tenant-wide fallback and the column is
   * NOT NULL DEFAULT 30, so an omitted value keeps 30.
   */
  default_payment_terms_days?: number;
  /**
   * IANA zone name — the tenant's local time (PRD-002 / conflict C6). The agent
   * guardrails need it to answer "is it 2am for this customer's supplier", and
   * it existed nowhere in `src/` before S10.
   */
  timezone?: string;
}

const PROFILE_FIELDS = [
  "legal_name",
  "reg_no",
  "tax_no",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postcode",
  "country",
  "phone",
  "email",
  "website",
  "default_prepared_by",
  "base_currency",
  "default_payment_terms_days",
  "timezone",
] as const;

/**
 * Full-replace upsert of the tenant's company profile (one row per tenant).
 * Also renames the tenant to the legal name, atomically: the workspace name
 * shown in the console (tenants.name, set at provisioning) and the seller
 * identity on documents must not drift apart once the company fills in its
 * real name (e.g. during onboarding).
 */
export async function upsertCompanyProfile(
  db: D1Database,
  tenantId: string,
  input: CompanyProfileInput,
): Promise<CompanyProfile> {
  const binds = PROFILE_FIELDS.map((f) => {
    if (f === "legal_name") return input.legal_name;
    // NOT NULL column — a blank/omitted value falls back to the default.
    if (f === "base_currency") return input.base_currency ?? DEFAULT_BASE_CURRENCY;
    // NOT NULL column, same treatment as base_currency.
    if (f === "default_payment_terms_days")
      return input.default_payment_terms_days ?? DEFAULT_PAYMENT_TERMS_DAYS;
    // NOT NULL column, same treatment again. The route validates the zone name
    // against Intl before it reaches here; this is the "no value sent" path.
    if (f === "timezone") return input.timezone ?? DEFAULT_TIME_ZONE;
    return input[f] ?? null;
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO company_profile (tenant_id, ${PROFILE_FIELDS.join(", ")}, updated_at)
         VALUES (?, ${PROFILE_FIELDS.map(() => "?").join(", ")}, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET
           ${PROFILE_FIELDS.map((f) => `${f} = excluded.${f}`).join(", ")},
           updated_at = excluded.updated_at`,
      )
      .bind(tenantId, ...binds, new Date().toISOString()),
    db
      .prepare("UPDATE tenants SET name = ? WHERE tenant_id = ?")
      .bind(input.legal_name, tenantId),
  ]);
  return (await getCompanyProfile(db, tenantId)) as CompanyProfile;
}

/**
 * The company-wide default currency for new documents (invoices, deals,
 * quotes). Documents stay multi-currency — callers apply this only when a
 * create request omits currency. No profile row => MYR.
 */
export async function resolveBaseCurrency(db: D1Database, tenantId: string): Promise<string> {
  const row = await db
    .prepare("SELECT base_currency FROM company_profile WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ base_currency: string }>();
  return row?.base_currency ?? DEFAULT_BASE_CURRENCY;
}

/**
 * The default currency for a new quote. A currency explicitly stored in the
 * quote branding template config wins (it's the quote-specific override);
 * otherwise the company base currency applies. The stored blob is inspected
 * raw because `resolveTemplateConfig` fills the currency default in, which
 * would make "never configured" indistinguishable from "configured MYR".
 */
export async function resolveQuoteDefaultCurrency(
  db: D1Database,
  tenantId: string,
): Promise<string> {
  const row = await db
    .prepare("SELECT template_config FROM quote_branding WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ template_config: string }>();
  if (row) {
    try {
      const cfg = JSON.parse(row.template_config || "{}") as { currency?: unknown };
      if (typeof cfg.currency === "string" && cfg.currency.length === 3) {
        return cfg.currency.toUpperCase();
      }
    } catch {
      // Malformed blob — same "never break on bad config" rule as rendering.
    }
  }
  return resolveBaseCurrency(db, tenantId);
}

interface BrandingRow {
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  font_family: string;
  template_config: string;
}

/** Resolve the tenant's branding, falling back to defaults when there is no row. */
export async function getQuoteBranding(
  db: D1Database,
  tenantId: string,
): Promise<QuoteBranding> {
  const row = await db
    .prepare(
      "SELECT logo_url, primary_color, accent_color, font_family, template_config FROM quote_branding WHERE tenant_id = ?",
    )
    .bind(tenantId)
    .first<BrandingRow>();
  if (!row) return DEFAULT_BRANDING;
  return {
    logo_url: row.logo_url,
    primary_color: row.primary_color,
    accent_color: row.accent_color,
    font_family: row.font_family,
    template_config: resolveTemplateConfig(row.template_config),
  };
}

export interface QuoteBrandingInput {
  logo_url?: string | null;
  primary_color?: string;
  accent_color?: string;
  font_family?: string;
  template_config?: Partial<QuoteTemplateConfig>;
}

/** Full-replace upsert of the tenant's quote branding. */
export async function upsertQuoteBranding(
  db: D1Database,
  tenantId: string,
  input: QuoteBrandingInput,
): Promise<QuoteBranding> {
  const primary = input.primary_color ?? DEFAULT_BRANDING.primary_color;
  const accent = input.accent_color ?? DEFAULT_BRANDING.accent_color;
  const font = input.font_family ?? DEFAULT_BRANDING.font_family;
  // Re-validate through the schema so stored JSON is always well-formed and complete.
  const config = quoteTemplateConfigSchema.parse(input.template_config ?? {});
  await db
    .prepare(
      `INSERT INTO quote_branding (tenant_id, logo_url, primary_color, accent_color, font_family, template_config, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET
         logo_url = excluded.logo_url,
         primary_color = excluded.primary_color,
         accent_color = excluded.accent_color,
         font_family = excluded.font_family,
         template_config = excluded.template_config,
         updated_at = excluded.updated_at`,
    )
    .bind(
      tenantId,
      input.logo_url ?? null,
      primary,
      accent,
      font,
      JSON.stringify(config),
      new Date().toISOString(),
    )
    .run();
  return getQuoteBranding(db, tenantId);
}
