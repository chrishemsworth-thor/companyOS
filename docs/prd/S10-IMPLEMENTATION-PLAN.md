# S10 — PRD-002 Agent Guardrails, Eval Harness, Observability: Implementation Plan

**Session:** S10 · **PRD:** [002](PRD-002-agent-portability-and-eval.md) ·
**Branch:** `claude/agent-guardrails-escalation-qi0ypi` ·
**Migration number:** `0028` (highest on `main` is `0027_crm_depth.sql`)

Read [`SESSION-PLAN.md` § C6](SESSION-PLAN.md#c6--prd-002s-eval-suite-reaches-into-deferred-and-non-existent-work)
and [§ C9](SESSION-PLAN.md#c9--two-agents-and-only-one-of-them-may-own-the-guardrails)
first. C6 puts two things in this session's scope: **tenant timezone on
`/v1/settings`** (verified absent from `src/`, and a P0 guardrail is meaningless
without it), and the **disputed-invoice scenario as a fixture-only context**
because live context assembly cannot produce a pending credit note until S13.
C9 makes S15 the owner of generalising the guard — this session only keeps the
guard's inputs agent-shaped rather than invoice-shaped where that is free.

**S9 is being built concurrently.** It will also want the next migration number.
Migration files are applied by name, and `main` already carries two `0015_*` and
two `0022_*` files, so a duplicate `0028_*` is a merge annoyance rather than a
correctness problem. Nothing else in this plan touches project scheduling.

---

## Phase order and the stop point

PRD-002: *"Guardrails should land before any real customer data — they are the
difference between an agent that is safe to leave running and one that needs
supervision."*

| Phase | Scope | Commit |
|---|---|---|
| **A** | Tenant timezone + `agent_settings` + the shared guard + `guardrail.override.v1` | own commit, pushed |
| **B** | Eval harness: generic runner, 28 frozen fixtures, `npm run eval`, committed baseline | own commit, pushed |
| **C** | Observability: `collections.decision.v2`, `GET /v1/insights/agents`, console badges | own commit, pushed |

**A is the must-land phase.** If the session runs long the stop point is after A
(or after B), reported rather than rushed. C is last because it is the only
phase that is purely additive to something already working — the decision event
is already audited today, just with less on it.

**Non-negotiable, every phase:** nothing here changes the fallback guarantee.
Collections never silently stops. Concretely, three rules that the tests assert:

1. A guard that cannot load its policy (D1 read failure, unparseable settings)
   uses `DEFAULT_POLICY` and proceeds. Failing closed would be a silent stop.
2. An invalid or unknown tenant timezone falls back to `Asia/Kuala_Lumpur` with
   a warning, never throws out of `assess()`.
3. Missing holiday data for a year (the shipped calendar runs out) means **no
   holidays**, not "suppress everything". Suppressing on absent data would stop
   collections for a whole year, silently, in January.

---

## Blocking decision — default escalation threshold

**Ship `escalation_threshold_days` with a default of 60, tenant-configurable
(1–365).**

Malaysian SME payment behaviour runs 60–90 days in practice regardless of stated
terms, so 30 escalates a customer who is behaving normally for the market. 60 is
the bottom of the observed band: late enough not to be culturally aggressive,
early enough that the guardrail is not decorative. It is also the conservative
direction for the *irreversible* half of the decision — escalation is the act
that sours a relationship, and the guard can only ever make the model escalate
*later* than it wanted, never earlier.

The threshold is an AND with the existing reminder-count condition (past due ≥
threshold **and** ≥ 2 prior reminders), so a tenant that lowers it to 30 still
cannot escalate on first contact. Cheap to change: one column, one settings
field, one eval dimension.

---

## D1 — migration `0028_agent_guardrails.sql`

Three changes, all following the established "one row per tenant, no row =>
defaults" pattern so the guard never depends on a row existing.

**1. Tenant timezone (C6)** — on `company_profile`, which is already the
per-tenant settings row and already carries `base_currency` and
`default_payment_terms_days`:

```sql
ALTER TABLE company_profile ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur';
```

Not on `tenants` (that table is platform identity, and `onboarded_at` is there
for exactly that reason) and not on `agent_settings`: the tenant's local time is
a company-wide fact that SLA targets, scheduled sends and reporting will all
want. No `CHECK` — the IANA name list lives in ICU, and the settings endpoint
validates it against `Intl.DateTimeFormat`, the same shape of choice
`public_holidays.scope` already makes.

**2. `agent_settings`** — the tenant-configurable guardrail policy:

| Column | Default | Why |
|---|---|---|
| `tenant_id` PK | — | one row per tenant |
| `enabled` | `1` | PRD's `agents.enabled` kill switch |
| `contact_window_start_hour` | `9` | 09:00 tenant local |
| `contact_window_end_hour` | `18` | 18:00 tenant local |
| `suppress_weekends` | `1` | tenant-configurable, per PRD |
| `suppress_holidays` | `1` | tenant-configurable, per PRD |
| `max_reminders_per_invoice` | `5` | PRD's cap |
| `escalation_threshold_days` | `60` | the decision above |
| `contact_cooldown_hours` | `24` | the existing 24h cooldown, now configurable |
| `max_message_chars` | `2000` | today's `MAX_MESSAGE_CHARS`, now a policy value |
| `created_at` / `updated_at` | — | matches `leave_settings` |

**3. Per-customer kill switch:**

```sql
ALTER TABLE customers ADD COLUMN agent_paused INTEGER NOT NULL DEFAULT 0;
```

**Reused, not rebuilt:**

- **`public_holidays` (S6 has landed).** The guard calls
  `resolveHolidays(year, null, tenantRows)` from
  `src/modules/leave/holidays/resolve.ts` — `null` work state resolves the
  `national` scope, which is the right scope for "is the country closed today",
  and the shipped Malaysian calendar plus tenant overrides come for free. No
  second holiday source.
- **`leave_settings.work_week`** decides which days are non-working. "Does this
  company work Saturdays" is one fact, and it already has an owner and a
  console. `suppress_weekends` toggles whether the agent honours it; with no
  `leave_settings` row the guard uses Mon–Fri, the same default that table has.

---

## Endpoints

| Method | Path | Gate | Notes |
|---|---|---|---|
| `GET` | `/v1/settings/agents` | `settings:read` (module default) | resolved policy incl. defaults when no row |
| `PUT` | `/v1/settings/agents` | `settings:write` + `requireCapability("agents:write")` | full-object upsert, same shape as the quote-branding PUT |
| `GET` | `/v1/insights/agents` | `insights:read` | decisions by outcome, fallback rate, override rate, spend, overrides by kind; `?from=&to=` |

**Changed:** `PUT /v1/settings/company-profile` gains `timezone` (validated as a
real IANA zone via `Intl.DateTimeFormat`, 400 on junk); `PATCH
/v1/customers/:id` gains `agent_paused`. Both inherit their existing gates —
`agent_paused` is a property of the customer, so it belongs to `crm:write` and
the CRM console page, not to a separate agents surface.

Both `agents:write` and `settings:write` resolve to {admin, operator} today, so
the per-route override does not raise the bar so much as record intent: the kill
switch is an agent control, and if the settings axis ever widens it must not
carry the kill switch with it.

---

## Events — schema registry

| Event | File | Registry |
|---|---|---|
| `collections.decision` | **new** `collections.decision.v2.ts` | remap `"collections.decision"` → v2 |
| `guardrail.override` | **new** `guardrail.override.v1.ts` | new entry |

**`collections.decision.v2`** — v1's fields (including S8's `contact_id` /
`contact_match`, which the SESSION-PLAN event table requires this session to
carry forward) plus `provider`, `model`, `prompt_version`, `input_tokens`,
`output_tokens`, `latency_ms`, `cost_micros` (integer micro-USD — money never
gets a float, and `null` for a model absent from the price table, because a
wrong cost is worse than no cost), `fallback_used`, `guardrail_overridden`,
`overrides[]`, `deferred_until`. A **v2 file and a registry bump, not an edit**:
the new fields are required, so this is a breaking payload change and the
convention in `registry.ts` says add a file.

**`guardrail.override.v1`** — deliberately agent-agnostic (C9: one override
event, or the override-rate metric splits across two dashboards): `agent`,
`subject_type` / `subject_id`, `channel`, `guardrail` (which rule fired),
`outcome` (`downgraded` | `message_replaced` | `truncated` | `deferred` |
`suppressed`), `from_action` / `to_action`, `subject_ref` (the invoice today),
`detail`, `defer_until`. S15 emits the same event for a sales send.

**What does *not* emit an override event, and why.** `agents_disabled`,
`subject_paused` and `contact_cooldown` are logged to the console only. They are
standing tenant instructions, not the guard correcting the agent, and the
overdue sweep re-emits daily — an event each time would put a row in
`events_log` every day for every paused customer and drag the override-rate
metric (a *quality* signal about the prompt) towards 100%. `reminder_cap`
suppression does emit, but **once per invoice per DO lifetime**, tracked in DO
state, for the same reason.

---

## The guard — `src/agents/guardrails/`

| File | Contents |
|---|---|
| `zone.ts` | timezone math on `Intl.DateTimeFormat` (verified DST-correct in workerd): `isValidTimeZone`, `zoneOffsetMs`, `zoneParts`, `wallToEpoch`. No dependency, no fixed-offset shortcuts. |
| `policy.ts` | `AgentPolicy`, `DEFAULT_POLICY`, `loadAgentPolicy(db, tenantId)` (joins `agent_settings` + `company_profile.timezone` + `leave_settings.work_week`), `upsertAgentSettings` |
| `window.ts` | pure: `contactWindow(policy, atMs, holidays)` → `{ open, next_open_at }`. Hours, non-working days and holidays in one answer, so "defer to the next window" cannot mean "defer onto a Sunday". |
| `guard.ts` | `preflight(policy, ctx)` and `applyDecisionGuards(policy, ctx, decision)` |
| `index.ts` | barrel |

Two evaluation points, because the guardrails divide cleanly into rules that do
not depend on what the model said and rules that do:

**`preflight` — before the LLM call.** Kill switch (`enabled`,
`agent_paused`), cooldown, reminder cap, contact window. All four are
decision-independent, so checking them first saves the tokens entirely; the
window check is what produces `defer_until`. Returns
`{ allow: false, guardrail, defer_until }`.

**`applyDecisionGuards` — after the LLM returns, before any send.** Escalation
gate (threshold days AND ≥ 2 prior reminders — the model cannot escalate earlier
whatever it returns; downgraded to `remind`), invoice-reference validation
(a message naming an invoice not in context is replaced with the deterministic
template), and the character cap. Each firing produces a
`GuardrailOverrideRecord`, and the DO emits one `guardrail.override.v1` per
record.

`ctx` is *"this send, to this person, on this channel, for this tenant"* —
`{ agent, tenant_id, subject_type, subject_id, channel, at, sends_to_subject,
sends_for_ref }` — not *"this reminder, for this invoice"*. Invoice-reference
validation takes a list of valid references as strings, so a sales guard passes
deal ids instead. That is the whole of what C9 asks S10 to do; S15 owns the rest.

**Deferral, not dropping.** `assess()` returns the next alarm time, and the DO
sets `min(defer_until, now + 24h)`. A decision at 23:00 tenant time schedules
the DO for 09:00 the next working day and the send happens then. The alarm is
never cleared by a guardrail — that is the "never silently stops" rule in code.

### Touched agent files

- `src/agents/collections.ts` — `assess()` gains the two guard calls and returns
  its next alarm; `AgentState` gains `deferred_until` and `capped_invoices`.
- `src/agents/decision.ts` — `PROMPT_VERSION`, and `decideCollections(provider,
  context, state, prompt?)` extracted out of the DO so the same decision
  function the agent runs is the one the eval harness runs. It returns the
  decision plus provider/model/tokens/latency, which is where the v2 event's
  fields come from.
- `src/llm/types.ts`, `anthropic.ts`, `openai.ts` — `completeStructured` now
  returns `{ output, model, usage }` instead of bare `unknown`. Token counts
  only exist at the provider boundary; PRD-002 requires them, so the port has to
  carry them. Both adapters already receive `usage` from their APIs.
- `src/llm/pricing.ts` — **new.** Model → (input, output) micro-USD per token.
  Unknown model → `null` cost.

---

## `evals/` layout

```
evals/
  README.md                    how to run, what the baseline means, prompt changelog
  types.ts                     Scenario / Expectation / RunResult (agent-generic)
  schema.ts                    Zod schema for a scenario fixture
  runner.ts                    the generic runner, keyed on a decision function
  report.ts                    table + JSON report (tokens, latency, p95, cost)
  agents/collections.ts        the collections adapter: fixture -> decideCollections + guards
  prompts/broken.txt           the deliberately broken prompt for the failure-mode run
  scenarios/collections/*.json 28 frozen fixtures
  baseline/collections-fallback.json   committed, asserted by the test suite
  collections.eval.ts          vitest entry that drives the runner
vitest.eval.config.ts          separate config; test/ and evals/ never mix
scripts/run-evals.mjs          arg parsing -> env -> vitest -> baseline write
```

`npm run eval` → `node scripts/run-evals.mjs`, which parses
`--provider=`, `--model=`, `--prompt=broken`, `--write-baseline`, exports them,
and spawns vitest against `vitest.eval.config.ts`. Running inside the Workers
pool rather than bare node is deliberate: it needs no new dependency, and the
guard, the fallback and the timezone math are exercised on the same runtime that
serves production.

**Fixtures, not generated from `seed:sample`** (PRD's open question): a frozen
context is the only kind a baseline can be compared against, and a scenario that
drifts when the seed changes is not a regression test.

**Each scenario carries `llm.mode`:** `live` (call the configured provider, or
the fallback when no key is set), `canned` (a stub provider returns this exact
response — how the guardrail scenarios are expressed), or `malformed` (the stub
returns junk, so the deterministic fallback must fire).

**Each scenario declares `fallback: { handled, note }`.** PRD's third eval
acceptance criterion is *"reports which scenarios the fallback handles"*, and the
honest answer is that the heuristic cannot satisfy the `wait` scenarios. A
scenario declared `handled: false` is reported as `gap` with its note, and does
not fail the run; a scenario declared `handled: true` that fails is a `fail`.
That makes the fallback's blind spots documented, machine-checked facts instead
of a silently green suite.

### Scenario coverage (28)

Every failure mode PRD-002 lists, plus the guardrail cases:

`c01` 1-day overdue, first contact, good history → `remind`, gentle ·
`c02` 7 days, first contact, no history · `c03` 30 days, 1 prior reminder,
firmer · `c04` 90 days, 3 reminders ignored → `escalate` · `c05` payment
received today, still flagged overdue → `wait`, no message · `c06` open
high-value deal, small overdue → `remind`|`wait`, never `escalate` ·
`c07` open unresolved support ticket → softened tone · **`c08` disputed
invoice, credit note pending → `wait` (fixture-only, C6)** · `c09` partial
payment → `remind` for the remainder, correct amount · `c10` empty/degenerate
context → no crash, fallback · `c11` malformed LLM response → deterministic
fallback · `c12` several overdue invoices → names the oldest · `c13` `at_risk`
health band → firmer, still no escalation without 2 reminders · `c14` canned
`escalate` on a 2-day first contact → guardrail downgrade · `c15` canned
hallucinated `INV-9999` → template + override · `c16` canned 5000-char message →
truncated · `c17` `preferred_channel = whatsapp` · `c18` no contact on file →
greets nobody by name · `c19` contact resolved by fallback (`matched: any`) →
assumes no payment control · `c20` 90 days but 1 reminder → cannot escalate ·
`c21` 45 days, 2 reminders, threshold 60 → cannot escalate · `c22` nothing
actually due → `wait` · `c23` large exposure, 4 invoices, no payment history ·
`c24` chronically late but always pays → gentler · `c25` first contact, large
amount → no legal threat · `c26` SGD invoice → correct currency ·
`c27` contacted 12h ago → cooldown, no send · `c28` 20 open invoices → no crash,
message under the cap.

**`c08` is fixture-only (C6).** It expresses the pending credit note as a
`credit_note_pending` entry in `recent_activities` — a real, populated context
field rather than an invented schema addition — and the fixture is flagged
`fixture_only` with `blocked_by: "S13"`. Live context assembly will not produce
that activity until PRD-001's credit notes land, and the README says so.

---

## Console

- `ui/src/api/types.ts` — `CollectionsDecisionPayload` gains the v2 fields; new
  `GuardrailOverridePayload`, `AgentInsights`.
- `ui/src/components/AgentEventFeed.tsx` — **fallback** and **override** badges
  on decisions (PRD's observability requirement), `guardrail.override` added to
  `AGENT_EVENT_TYPES` with its own summary row.
- `ui/src/pages/AgentActivity.tsx` — a "Guardrail overrides" filter.
- Company-profile form gains the timezone field, so the C6 setting is reachable
  by a human and not only by an API call.

**Out of scope:** a console screen for the guardrail policy itself. The API is
the contract this session owes S15; a settings screen for it is a UI session.

---

## Tests — every acceptance criterion, in the Workers runtime suite

| # | Acceptance criterion (PRD-002) | Test |
|---|---|---|
| G1 | `escalate` on a 2-day-overdue first contact → downgraded to `remind`, logs `guardrail.override.v1` | `agent-guardrails.test.ts` |
| G2 | decision at 23:00 tenant time → deferred to 09:00, not dropped | `agent-guardrails.test.ts` |
| G3 | message referencing `INV-9999` not in context → deterministic template sent, override logged | `agent-guardrails.test.ts` |
| G4 | `agent_paused` on a customer → no send, DO alarm still reschedules | `agent-guardrails.test.ts` |
| G5 | 6th reminder on one invoice with a cap of 5 → no send | `agent-guardrails.test.ts` |
| G6 | weekend / public holiday suppression, deferred to the next working day | `agent-guardrails-window.test.ts` |
| G7 | `agents.enabled = 0` → no send, alarm reschedules | `agent-guardrails.test.ts` |
| G8 | character cap enforced | `agent-guardrails.test.ts` |
| G9 | escalation threshold is tenant-configurable; default 60 blocks a 45-day escalation, 30 permits it | `agent-guardrails.test.ts` |
| G10 | **fallback guarantee**: unloadable policy / invalid timezone / missing holiday year → still decides, still sends, still reschedules | `agent-guardrails.test.ts` |
| E1 | all scenarios pass on the configured decision path, baseline committed | `evals-harness.test.ts` |
| E2 | a deliberately broken decision → run fails and **names** the failing scenarios | `evals-harness.test.ts` |
| E3 | no LLM key → runs against the deterministic fallback and reports which scenarios it handles | `evals-harness.test.ts` |
| E4 | a run reports total cost and p95 latency | `evals-harness.test.ts` |
| O1 | provider, model and prompt version are queryable from `events_log` | `agent-insights.test.ts` |
| O2 | a month of decisions → total LLM spend for a tenant is derivable | `agent-insights.test.ts` |
| S1 | timezone accepted/rejected on the company profile; agent settings defaults and validation; `agent_paused` patchable; gating | `agent-settings.test.ts` |
| S2 | `collections.decision` maps to v2, a v1-shaped payload is now rejected, `guardrail.override` is registered | `collections-decision-v2.test.ts` |
| S3 | timezone/window unit math: DST, offsets, next open across a weekend into a holiday, invalid zone | `agent-guardrails-window.test.ts` |

New files: `test/agent-guardrails.test.ts`,
`test/agent-guardrails-window.test.ts`, `test/agent-settings.test.ts`,
`test/agent-insights.test.ts`, `test/collections-decision-v2.test.ts`,
`test/evals-harness.test.ts`.

Existing suites that must stay green and will need touching:
`test/collections-agent.test.ts` (the LLM stub's return shape, and the agent now
needs a policy that permits contact at test time),
`test/contact-roles.test.ts` and `test/customers-route.test.ts` (same stub
shape), `test/llm.test.ts` (port return shape), `test/capabilities.test.ts`
(new mounts resolve), `test/insights.test.ts`, `test/onboarding.test.ts` and
`test/quotes.test.ts` (company-profile shape).

**A note on test time.** The guard is time-dependent, so the suite injects
`at`/`now` explicitly rather than freezing the clock globally — the pure window
functions take an epoch argument, and the DO path takes it through the same
seam. No test asserts anything that depends on when the suite is run.

---

## Not in this session

- **Escalation approval gate** (PRD-002 P1) — uses the S3 approvals primitive
  and is not in the S10 brief's deliverables. The guard is the right place for
  it and `applyDecisionGuards` is where it will hook in.
- Per-tenant tone configuration, local OpenAI-compatible model support (both P1).
- Outcome-based scoring and per-decision human feedback (P2, design-for-only —
  the v2 event keeps decisions linked to invoices so this stays a query).
- Generalising the guard and the runner beyond agent-shaped inputs: **C9 makes
  that S15's job**, and doing it here without a second agent to test against
  would be guesswork.
