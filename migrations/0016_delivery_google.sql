-- Point a tenant's email delivery at a connected Google (Gmail) account, so
-- invoice reminders and other DeliveryProvider sends go out through Gmail
-- instead of Resend. When google_account_id is set on the email row, the
-- dispatcher uses GmailReminderAdapter (src/integrations/google/delivery.ts);
-- otherwise the existing Resend/console path is unchanged.
ALTER TABLE delivery_config
  ADD COLUMN google_account_id TEXT REFERENCES google_accounts(account_id);

-- Widen the deliveries.provider CHECK to include 'google'. SQLite can't alter a
-- CHECK constraint in place, so rebuild the (append-only) table: create the new
-- shape, copy every row, swap, and recreate the indexes. Nothing references
-- deliveries by foreign key, so the drop/rename is safe.
CREATE TABLE deliveries_new (
  delivery_id  TEXT NOT NULL,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  invoice_id   TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  provider     TEXT NOT NULL CHECK (provider IN ('console', 'resend', 'twilio', 'google')),
  to_address   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  delivery_ref TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, delivery_id)
);

INSERT INTO deliveries_new
  (delivery_id, tenant_id, invoice_id, customer_id, channel, provider, to_address, status, delivery_ref, created_at)
  SELECT delivery_id, tenant_id, invoice_id, customer_id, channel, provider, to_address, status, delivery_ref, created_at
  FROM deliveries;

DROP TABLE deliveries;
ALTER TABLE deliveries_new RENAME TO deliveries;

CREATE INDEX idx_deliveries_customer ON deliveries (tenant_id, customer_id, created_at);
CREATE INDEX idx_deliveries_invoice ON deliveries (tenant_id, invoice_id);
