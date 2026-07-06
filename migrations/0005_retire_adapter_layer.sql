-- CompanyOS Phase 1 — the OSS adapter layer is retired. All modules are
-- native; there are no per-tenant external module instances to hold
-- credentials for. (The one remaining external boundary, outbound delivery,
-- is configured per deployment, not per tenant — for now.)

DROP TABLE tenant_credentials;
