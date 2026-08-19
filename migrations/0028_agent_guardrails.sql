-- PRD-002 (S10) — agent guardrails.
--
-- Three things the guardrail layer cannot exist without: the tenant's local
-- time, the tenant-configurable policy, and a per-customer off switch.
--
-- Everything here follows the `company_profile` / `delivery_config` pattern of
-- "one row per tenant, no row => defaults". That is load-bearing rather than
-- stylistic: the guard runs inside a Durable Object on the send path, and a
-- guard that needs a row to exist would fail on the first tenant who never
-- opened Settings — which, for a guard, means either an unbounded agent or a
-- silently stopped one. PRD-002 forbids both.

-- ---------------------------------------------------------------------------
-- Tenant local time (SESSION-PLAN conflict C6).
--
-- PRD-002's "no contact outside 09:00-18:00 tenant local time" is meaningless
-- without this, and it existed nowhere in src/. It goes on `company_profile`
-- rather than `agent_settings` because the tenant's timezone is a company-wide
-- fact — SLA targets, scheduled sends and any report with a "today" in it will
-- all want the same answer — and on `company_profile` rather than `tenants`
-- because that table is platform identity, which is why `onboarded_at` is
-- there and `base_currency` is not.
--
-- No CHECK constraint: the authoritative list of IANA zone names lives in ICU,
-- not in SQL. `PUT /v1/settings/company-profile` validates against
-- Intl.DateTimeFormat — the same choice `public_holidays.scope` makes by
-- validating scope codes in the service instead.
-- ---------------------------------------------------------------------------
ALTER TABLE company_profile ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur';

-- ---------------------------------------------------------------------------
-- The guardrail policy. Every value PRD-002 calls tenant-configurable, and
-- nothing else: a column here is a promise that a tenant can change it.
-- ---------------------------------------------------------------------------
CREATE TABLE agent_settings (
  tenant_id                 TEXT NOT NULL PRIMARY KEY REFERENCES tenants(tenant_id),

  -- PRD-002's kill switch. The per-customer half is `customers.agent_paused`
  -- below; both are checked before any send.
  enabled                   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- Contact window in TENANT LOCAL time, half-open [start, end): 9..18 means a
  -- send at 17:59 is fine and 18:00 is not. "A WhatsApp at 2am is a
  -- product-defining mistake" — so the window is stored, not hardcoded, and
  -- the guard defers into it rather than dropping the send.
  contact_window_start_hour INTEGER NOT NULL DEFAULT 9  CHECK (contact_window_start_hour BETWEEN 0 AND 23),
  contact_window_end_hour   INTEGER NOT NULL DEFAULT 18 CHECK (contact_window_end_hour BETWEEN 1 AND 24),

  -- Whether the agent honours non-working days and public holidays. Which days
  -- those ARE is not stored here: the work week comes from
  -- `leave_settings.work_week` and holidays from `public_holidays` (S6), both
  -- of which already have an owner, a console and a Malaysian default. A
  -- second copy of "does this company work Saturdays" is how the two answers
  -- start disagreeing.
  suppress_weekends         INTEGER NOT NULL DEFAULT 1 CHECK (suppress_weekends IN (0, 1)),
  suppress_holidays         INTEGER NOT NULL DEFAULT 1 CHECK (suppress_holidays IN (0, 1)),

  max_reminders_per_invoice INTEGER NOT NULL DEFAULT 5 CHECK (max_reminders_per_invoice >= 1),

  -- The blocking product decision, answered: 60 days, not 30. Malaysian SME
  -- payment behaviour runs 60-90 days in practice regardless of stated terms,
  -- so 30 escalates a customer who is behaving normally for the market. 60 is
  -- the bottom of that band, and escalation is the irreversible half of the
  -- decision. ANDed with ">= 2 prior reminders" in the guard, so lowering this
  -- still cannot escalate on first contact.
  escalation_threshold_days INTEGER NOT NULL DEFAULT 60 CHECK (escalation_threshold_days BETWEEN 1 AND 365),

  contact_cooldown_hours    INTEGER NOT NULL DEFAULT 24 CHECK (contact_cooldown_hours BETWEEN 1 AND 720),
  max_message_chars         INTEGER NOT NULL DEFAULT 2000 CHECK (max_message_chars BETWEEN 200 AND 10000),

  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Per-customer pause — the other half of PRD-002's kill switch.
--
-- On `customers` rather than in an agents-owned table because it is a property
-- of the customer relationship ("do not let the robot talk to this one"), which
-- is what makes it a CRM edit on the customer page rather than a settings
-- screen. PRD-003 (S8) already named this column as the seam it was leaving for
-- this session when it decided derived health must NOT auto-pause anything.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN agent_paused INTEGER NOT NULL DEFAULT 0;
