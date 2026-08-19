import { z } from "zod";

/**
 * Per-company quote design — this is the "configurable per company" surface.
 * Brand identity (logo, colours, font) are real columns on `quote_branding`;
 * the many section/field toggles, labels and formats live in a single JSON
 * `template_config` blob validated by this schema. Every field has a default,
 * so a tenant with no branding row (or a partial one) still renders a complete,
 * sensible document — mirroring the `delivery_config` "no row => off/defaults"
 * convention.
 */

export const NUMBER_FORMATS = ["1,234.56", "1.234,56"] as const;
export const DATE_FORMATS = ["DD/MM/YYYY", "YYYY-MM-DD", "DD MMM YYYY"] as const;

export const quoteTemplateConfigSchema = z
  .object({
    // Which columns / sections appear on the document.
    show_discount_column: z.boolean().default(true),
    show_line_notes: z.boolean().default(true),
    show_tax_line: z.boolean().default(true),
    show_signature_block: z.boolean().default(true),
    show_terms: z.boolean().default(false),
    // Tax modelling (single header rate). 600 bps = 6% (Malaysian SST).
    tax_rate_bps: z.number().int().min(0).max(10_000).default(600),
    tax_label: z.string().max(120).default("SST 6%"),
    // Content + locale.
    terms_text: z.string().max(20_000).default(""),
    currency: z.string().length(3).default("MYR"),
    number_format: z.enum(NUMBER_FORMATS).default("1,234.56"),
    date_format: z.enum(DATE_FORMATS).default("DD/MM/YYYY"),
    // Reserved for a later bilingual (MS/EN) label pack; English-only for now.
    bilingual: z.boolean().default(false),
    // Override any default document label by key, e.g. { "quote_title": "SEBUT HARGA" }.
    label_overrides: z.record(z.string()).default({}),
  })
  .strict();

export type QuoteTemplateConfig = z.infer<typeof quoteTemplateConfigSchema>;

/** Parse a stored (possibly empty/partial) config blob into a fully-defaulted config. */
export function resolveTemplateConfig(raw: unknown): QuoteTemplateConfig {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw || "{}");
    } catch {
      value = {};
    }
  }
  const parsed = quoteTemplateConfigSchema.safeParse(value ?? {});
  // A malformed stored blob must never break rendering: fall back to all defaults.
  return parsed.success ? parsed.data : quoteTemplateConfigSchema.parse({});
}

export interface QuoteBranding {
  /** An externally hosted logo. Predates file storage; still honoured. */
  logo_url: string | null;
  /**
   * A logo held by the file primitive with `purpose = quote_logo` (PRD-004 P0).
   * Wins over `logo_url` when both are set: a file this system owns cannot rot
   * the way somebody else's URL can, and `quote_logo` is the one purpose whose
   * bytes the credential-less `/files/:id` route will serve — which is what
   * makes it renderable on the public quote page.
   */
  logo_file_id: string | null;
  primary_color: string;
  accent_color: string;
  font_family: string;
  /**
   * Free text under the document: payment terms, bank details, registration
   * numbers. Distinct from `template_config.terms_text`, which is the
   * contractual terms *section* and is toggleable; this is the standing
   * footer that appears on every page.
   */
  footer_text: string | null;
  template_config: QuoteTemplateConfig;
}

export const DEFAULT_BRANDING: QuoteBranding = {
  logo_url: null,
  logo_file_id: null,
  primary_color: "#1a1a2e",
  accent_color: "#0f3460",
  font_family: "Helvetica, Arial, sans-serif",
  footer_text: null,
  template_config: quoteTemplateConfigSchema.parse({}),
};
