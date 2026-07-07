-- Migration 0009: index for the /v1/events feed (tenant + type filter,
-- newest-first cursor on event_id).
CREATE INDEX idx_events_log_tenant_type ON events_log (tenant_id, event_type, event_id);
