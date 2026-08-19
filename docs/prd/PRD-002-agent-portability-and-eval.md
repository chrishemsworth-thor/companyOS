# PRD-002 — Collections Agent: Model Portability & Evaluation Harness

**Status:** Built (portability ✅, guardrails ✅, evaluation ✅, observability ✅) ·
**Priority:** P1
**Depends on:** nothing · **Blocks:** confident model upgrades, future agents

**Shipped in S10** — see [`S10-IMPLEMENTATION-PLAN.md`](S10-IMPLEMENTATION-PLAN.md)
for the plan and [`../../evals/README.md`](../../evals/README.md) for how to run
the suite. P0 in full; the P1 escalation approval gate, per-tenant tone
configuration and local-model support are not built.

---

## Problem Statement

The CollectionsAgent is already provider-agnostic — an LLM port with Anthropic
(default `claude-opus-4-8`) and OpenAI implementations, Zod-validated structured
output, and a deterministic heuristic fallback when the LLM fails or no key is
configured. The portability question is answered.

The unanswered question is the more dangerous one: **there is no way to tell whether
a model, prompt, or provider change made collections better or worse.** Every decision
is logged to `events_log` as `collections.decision.v1`, but nothing scores them. Today
a provider swap is a silent, unmeasured bet placed on customers' money and customer
relationships — the agent can send a legally aggressive message or chase a customer
who paid yesterday, and we would find out from the customer.

## Goals

1. Any change to model, provider, or prompt can be evaluated against a fixed scenario
   set before it ships, with a pass/fail result.
2. The agent's behaviour is bounded by hard guardrails enforced in code, not by prompt
   instructions the model may ignore.
3. Cost and latency per decision are visible per tenant.
4. The eval harness is agent-generic so the future SalesAgent and SupportAgent reuse it.
5. Nothing in this PRD changes the fallback guarantee: collections never silently stops.

## Non-Goals

- **Fine-tuning or training.** Prompting plus guardrails is the strategy.
- **Automatic model selection / routing per decision.** Configured provider, not adaptive.
- **Human-in-the-loop approval of every reminder.** That defeats the product. An
  approval gate for *escalations* is P1.
- **Multi-agent negotiation.** Out of scope.
- **A/B testing across live tenants.** Pre-customer; offline eval only.

## User Stories

- As the founder, I want to run a scenario suite before switching models so that I know
  whether behaviour regressed.
- As the founder, I want a hard cap on message tone and frequency enforced in code so
  that a bad model response cannot damage a customer relationship.
- As a tenant admin, I want to see what the agent decided and why so that I trust it
  enough to leave it running.
- As a tenant admin, I want to require my approval before an account is escalated so
  that the agent cannot unilaterally sour a key relationship.
- As the founder, I want per-tenant LLM spend visible so that pricing can cover cost.

## Requirements

### P0 — Evaluation harness

- `evals/` directory with **25–30 frozen scenarios** as fixture files. Each contains:
  a full agent context (open invoices, payment history, CRM activities, open deals,
  prior contact log) and an expectation.
- Expectations are **ranges and constraints, not exact strings** — LLM output is
  non-deterministic. Assert on: chosen action within an allowed set, risk score within
  a band, channel choice, and message constraints (contains no threat of legal action
  unless scenario is `escalate`, mentions the correct invoice number, under N chars).
- Scenario coverage must include the failure modes that matter:
  - Invoice 1 day overdue, first contact, good history → expect `remind`, gentle
  - Invoice 90 days overdue, three prior reminders ignored → expect `escalate`
  - Payment received today, invoice still flagged overdue → expect `wait`, no message
  - Customer with an open high-value deal and a small overdue invoice → expect
    `remind` or `wait`, never `escalate`
  - Customer with an open unresolved support ticket → expect softened tone
  - Disputed invoice (credit note pending) → expect `wait`
  - Partial payment received → expect `remind` for the remainder, correct amount
  - Empty/degenerate context (no history at all) → must not crash, must fall back
  - Malformed LLM response → deterministic fallback fires
- `npm run eval` runs all scenarios against the configured provider and prints a table:
  scenario, expected, actual, pass/fail, tokens, latency, cost.
- `npm run eval -- --provider=openai --model=X` for comparison runs.
- The harness is a **generic runner** keyed on an agent's decision function so future
  agents plug in.
- CI: eval run is not a blocking gate (cost, non-determinism) but is a documented
  pre-merge step for any prompt or model change.

**Acceptance criteria**
- [x] Given the current default model, when `npm run eval` runs, then all scenarios
      pass and a baseline result is committed to the repo. *(The committed baseline is
      the deterministic one, `evals/baseline/collections-fallback.json` — 22 pass,
      6 declared fallback gaps, 0 failures. A model baseline needs a key and is
      captured with `npm run eval -- --write-baseline`.)*
- [x] Given a deliberately broken prompt, then the eval fails and names which scenarios.
      *(`evals/prompts/broken.ts` + `npm run eval -- --prompt=broken` for the live half;
      the reporting half is asserted against a canned bad decision in
      `test/evals-harness.test.ts`, since a prompt only changes behaviour through a model.)*
- [x] Given no LLM key configured, then eval runs against the deterministic fallback
      and reports which scenarios the fallback handles. *(Per check, not per scenario:
      a fixture declares `fallback.missing`, so "never escalate" stays enforced even
      where the risk band is a known blind spot.)*
- [x] Given a run, then total cost and p95 latency are reported. *(Cost in integer
      micro-USD; the total refuses to sum when any call's model had no known rate.)*

### P0 — Hard guardrails in code

Enforced after the LLM returns, before any send. A model response violating these is
overridden by the fallback, and the override is logged.

- Contact cooldown: 24h per customer (exists — move enforcement to a shared guard).
- **Maximum total reminders per invoice** (default 5, tenant-configurable).
- **No contact outside 09:00–18:00 tenant local time** — a WhatsApp at 2am is a
  product-defining mistake. Defer to the next window rather than dropping.
- **No contact on Malaysian public holidays or weekends** by default, tenant-configurable.
- Escalation requires: invoice past due by ≥ tenant threshold AND ≥ 2 prior reminders.
  The model cannot escalate earlier regardless of what it returns.
- Message must reference a real invoice number present in context. Reject and fall back
  on hallucinated references.
- Hard character cap on outbound messages.
- **Kill switch**: `agents.enabled` per tenant, and a per-customer `agent_paused` flag.
  Both checked before any send.

**Acceptance criteria**
- [x] Given an LLM response with `action=escalate` on a 2-day-overdue first contact,
      then the guardrail downgrades to `remind` and logs `guardrail.override.v1`.
      *(The downgrade also replaces the message: the escalation's wording must not
      go out as a reminder.)*
- [x] Given a decision made at 23:00 tenant time, then the send is deferred to 09:00,
      not dropped. *(Tenant-local via `company_profile.timezone`; the DO alarm is set to
      the window opening, and no guardrail can clear the alarm.)*
- [x] Given a message referencing invoice INV-9999 which is not in context, then the
      deterministic template is sent instead and the override is logged. *(Also when
      the message names no invoice at all — the requirement is a real reference,
      not merely the absence of a fake one.)*
- [x] Given `agent_paused` on a customer, then no send occurs and the DO alarm still
      reschedules. *(Not audited as an override: a standing instruction re-checked
      daily would bury the override rate.)*
- [x] Given the 6th reminder attempt on one invoice with a cap of 5, then no send.
      *(Audited once per invoice, not once a day: the cap is a terminal state.)*

### P0 — Decision observability

- Extend `collections.decision.v1` to record: provider, model, prompt version, token
  counts, latency, cost estimate, whether fallback was used, whether a guardrail
  overrode the decision.
- `GET /v1/insights/agents` — decisions by outcome, fallback rate, override rate,
  spend by period.
- Console Agent Activity feed shows fallback and override badges.

**Acceptance criteria**
- [x] Given any decision, then provider, model, and prompt version are queryable from
      `events_log`. *(`collections.decision.v2`; asserted as a `json_extract` query.)*
- [x] Given a month of decisions, then total LLM spend for a tenant is derivable.
      *(`GET /v1/insights/agents`, which also reports how many decisions it could not
      price rather than understating the total.)*

### P1

- **Escalation approval gate** — tenant setting requiring approval (PRD-000 primitive)
  before an escalation message sends.
- Prompt versioning with a changelog, so an eval baseline is tied to a prompt version.
- Per-tenant tone configuration (formal / friendly), evaluated as a scenario dimension.
- Local model support via an OpenAI-compatible endpoint for cost-sensitive tenants.

### P2 (design for, do not build)

- Outcome-based scoring: did the invoice get paid within N days of the agent's action?
  Requires real customer data. Keep decisions linked to invoices so this becomes a
  query later, not a migration.
- Human feedback on individual decisions (thumbs up/down) feeding a review set.

## Success Metrics

All four are now measurable rather than aspirational: the first from
`npm run eval`, the middle two from `GET /v1/insights/agents`
(`overrides.rate`, `fallback.rate`), and the last by construction.

- Eval suite passes on the default model with a committed baseline.
- Guardrail override rate on the eval suite < 10% (higher means the prompt is wrong,
  not that guardrails are working).
- Fallback rate in normal operation < 5%.
- Zero possibility, by construction, of an out-of-hours or over-cap send.

## Open Questions

- ~~**(Product, blocking)** What is the default escalation threshold in days?~~
  **Answered in S10: 60, tenant-configurable (1–365).** Malaysian norms run 60–90
  days regardless of stated terms, so 30 escalates a customer behaving normally
  for the market; 60 is the bottom of that band, and escalation is the
  irreversible half of the decision. ANDed with a non-configurable "≥ 2 prior
  reminders on that invoice". Still wants a design partner's view — it is one
  column, one settings field and one eval dimension to change.
- ~~**(Engineering, non-blocking)** Where does tenant local time live?~~
  **Answered in S10: `company_profile.timezone`**, an IANA name defaulting to
  `Asia/Kuala_Lumpur`, validated against `Intl.DateTimeFormat`. On the existing
  per-tenant settings row rather than an agent-owned one: SLA targets and any
  report with a "today" in it want the same answer.
- ~~**(Engineering, non-blocking)** JSON fixtures or generated from `seed:sample`?~~
  **Answered in S10: committed fixtures.** A baseline can only be compared against
  a frozen context, and a scenario that drifts when the seed changes is not a
  regression test. The cost — a fixture rotting against the context type — is paid
  by schema-validating every fixture on load.

**New, from running the harness:** the deterministic fallback's risk score
saturates. It is `min(100, days_overdue * 5 + reminders * 10)`, so anything past
about 20 days scores 100 and a 20-day-late invoice from a reliable customer reads
identically to a 200-day write-off. S10 recorded it rather than fixing it —
re-tuning the risk curve changes agent behaviour and wants a product decision.
See `evals/README.md`.

## Timeline Considerations

Guardrails should land before any real customer data — they are the difference between
an agent that is safe to leave running and one that needs supervision. The eval harness
can follow, but should exist before the first model or prompt change after launch.

No dependency on other PRDs. Good parallel work when blocked elsewhere.
