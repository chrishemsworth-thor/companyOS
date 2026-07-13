-- Migration 0011: audit attribution on the event log.
--
-- Adds "which actor caused this event" to events_log. Additive and nullable:
-- events emitted before this migration (and any emitted outside a request
-- context) keep NULL actor columns — the honest "pre-identity" / system marker.
--   actor_type: 'user' | 'agent' | 'system'
--   actor_id:   usr_<ulid> for users, an agent name for agents, NULL otherwise
ALTER TABLE events_log ADD COLUMN actor_type TEXT;
ALTER TABLE events_log ADD COLUMN actor_id TEXT;
