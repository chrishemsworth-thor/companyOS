-- CompanyOS Phase 2 — idempotency keys (Workstream 4).
-- Honors the `Idempotency-Key` header on POST /v1/invoices and POST
-- /v1/payments so an agent's retry can never double-record a write. The row
-- is claimed (response_status/response_body left NULL) before the handler
-- runs, so two concurrent requests with the same key can't both execute —
-- the loser sees an in-flight conflict rather than racing the write.
CREATE TABLE idempotency_keys (
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  endpoint        TEXT NOT NULL,               -- e.g. 'invoices.create'
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,               -- sha256 of the request body
  response_status INTEGER,                     -- NULL while the request is in flight
  response_body   TEXT,                        -- JSON; NULL while in flight
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, endpoint, idempotency_key)
);
