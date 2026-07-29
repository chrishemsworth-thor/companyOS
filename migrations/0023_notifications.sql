-- PRD-000c — the notifications primitive.
--
-- One row per "somebody should know about this", addressed to a USER. The
-- table is deliberately dumb: a title, a body, and a pointer at the subject.
-- All the intelligence lives in two places outside it — the event consumer
-- that writes rows (src/modules/notifications/consumer.ts) and the console
-- that renders them.
--
-- Rows are created by an EVENT CONSUMER, never by module code. PRD-000 is
-- explicit about that, and it is the reason PRD-007's nudge emits
-- `approval.nudged` rather than inserting here directly (SESSION-PLAN conflict
-- C4): one writer for this table, one place to look when a notification is
-- missing. A module that wants to notify somebody emits an event and adds an
-- entry to the consumer's event→notification map.
--
-- `type` is the source `event_type` (e.g. `approval.requested`) rather than a
-- second vocabulary that would have to be kept in sync with the registry. The
-- console owns the human labels and the grouping.
--
-- `subject_type` is plain TEXT with no CHECK, the same considered divergence
-- `0021_files.sql` makes for `purpose` and `0022_approvals.sql` makes for
-- `subject_type` — a consuming module must cost zero migrations. It goes one
-- step further than those two, though: the known values are enumerated in
-- src/modules/notifications/types.ts but the consumer does NOT reject a value
-- missing from that list. Refusing to write the row would turn a cosmetic gap
-- (a generic card instead of a tailored one, which PRD-007 requires as a
-- fallback anyway) into a silently missing badge, which is worse.
--
-- THE FREE-PLAN CONSTRAINT SHAPES THIS TABLE. On a queue-less deploy
-- (wrangler.free.jsonc) events dispatch inline through src/queue/direct.ts,
-- where a throwing consumer is caught, logged and DROPPED — there is no retry
-- and no DLQ, and the business write that emitted the event has already
-- committed. So the insert must be idempotent rather than exactly-once:
-- `dedupe_key` carries a natural key derived from the event, the unique index
-- below makes a repeat a no-op, and the consumer uses INSERT OR IGNORE and
-- never throws. Redelivery on the paid plan is safe for the same reason.

CREATE TABLE notifications (
  notification_id TEXT NOT NULL,                 -- ntf_01J...
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  -- Who should see it. NOT NULL: a notification addressed to nobody is a row
  -- that will never be read and never be cleared.
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  -- The source event_type, unversioned, exactly as it appears on the wire and
  -- in `events_log.event_type` — so "which event produced this badge" is a
  -- string comparison, not a mapping table.
  type            TEXT NOT NULL,                 -- e.g. approval.requested
  -- What it is about. Opaque here; the console maps subject_type to a route
  -- (ui/src/lib/subjectRoutes.ts) and to a card renderer. Deliberately NOT a
  -- CHECK — see the note above.
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  -- Rendered at write time, not read time. The event carries the facts as they
  -- were when it happened; resolving names on read would make an old
  -- notification silently change its wording, and would cost a join per row on
  -- the one query that runs on every console page load.
  title           TEXT NOT NULL,
  body            TEXT,
  -- Natural key for idempotency, derived from the event by the consumer
  -- (`<event_type>:<approval_id>`). Stable across redelivery of the same event,
  -- distinct across genuinely different notifications for the same subject.
  dedupe_key      TEXT NOT NULL,
  -- NULL while unread. A timestamp rather than a boolean because "when did they
  -- see it" is the interesting question once approval SLAs land (PRD-007 P1).
  read_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, notification_id)
);

-- The idempotency guarantee. Scoped per user, not per tenant: one event
-- legitimately notifies several people (a decision tells the requester; a
-- request tells the approver), and each of those is a separate row carrying the
-- same dedupe_key.
CREATE UNIQUE INDEX idx_notifications_dedupe
  ON notifications (tenant_id, user_id, dedupe_key);

-- "My unread count" and "my recent notifications, newest first" — the two
-- queries the bell runs on every page load and every 60s poll.
CREATE INDEX idx_notifications_user
  ON notifications (tenant_id, user_id, read_at, notification_id);

-- Nudge rate-limit ledger (PRD-007: "a second nudge within 24h is blocked").
--
-- Its own table, for two reasons:
--
--  1. It must NOT be a column on `approvals`. The rate limit is PRD-007's rule
--     about a console affordance, not part of the approvals primitive's
--     lifecycle, and C4 puts it "in the service before the emit".
--  2. It cannot be derived from `notifications`. On the paid plan the
--     notification row is written asynchronously by the queue consumer, so a
--     second nudge seconds later would read a table that does not yet show the
--     first one and sail through. This ledger is written synchronously by the
--     request that emits, so the check is deterministic on both plans.
--
-- No FK to `approvals`: the id is validated by the service against a
-- tenant-scoped read before anything is written here, and keeping the reference
-- soft means this table has no ordering dependency on migration 0022.
CREATE TABLE approval_nudges (
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  approval_id TEXT NOT NULL,                     -- apr_...
  nudged_by   TEXT NOT NULL REFERENCES users(user_id),
  nudged_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Append-only history rather than one mutable "last nudged" row: "this
  -- request was chased four times" is the evidence behind PRD-007's P1
  -- approver-responsiveness report, and throwing it away now would be free to
  -- do and expensive to recover.
  PRIMARY KEY (tenant_id, approval_id, nudged_at)
);

-- "When was this last nudged" — the only read, and it wants the newest row.
CREATE INDEX idx_approval_nudges_recent
  ON approval_nudges (tenant_id, approval_id, nudged_at DESC);
