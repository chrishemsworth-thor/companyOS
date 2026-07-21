-- Migration 0017: company onboarding state + base currency.
--
-- CompanyOS gets a first-run onboarding journey (company profile -> teams ->
-- employees) for newly provisioned companies, plus a company-wide default
-- currency for new documents.
--
-- Base currency: documents (invoices, deals, quotes) stay multi-currency —
-- currency is still stored per row and can be set per document. base_currency
-- is only the DEFAULT applied when a create request omits currency. This
-- generalizes the per-quote default that already lives in
-- quote_branding.template_config.currency to a company-wide setting, and it
-- follows company_profile's "one row per tenant, no row => defaults" pattern
-- (no row means MYR, resolved in code).
ALTER TABLE company_profile ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'MYR'
  CHECK (length(base_currency) = 3);

-- Onboarding state on the tenant, not company_profile: it's platform
-- lifecycle, and it must exist before any profile row does. NULL = the
-- first-run wizard has not been completed (or dismissed) yet; the console
-- redirects the company's admin into /onboarding until this is set.
ALTER TABLE tenants ADD COLUMN onboarded_at TEXT;

-- Companies provisioned before this migration never saw the wizard and are
-- already in use — mark them onboarded so nobody gets surprise-redirected.
UPDATE tenants SET onboarded_at = datetime('now') WHERE onboarded_at IS NULL;
