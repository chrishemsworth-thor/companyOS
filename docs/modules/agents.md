# Agents — guardrails, evaluation, observability

Everything that decides **whether an agent's message may leave**, everything that
measures whether the agent's judgement is any good, and everything that records
what it cost. Built in S10 from [PRD-002](../prd/PRD-002-agent-portability-and-eval.md);
migration `0028_agent_guardrails.sql`.

| Layer | Lives in | Owns |
|---|---|---|
| **Guardrails** | `src/agents/guardrails/` | the kill switches, the contact window, the cooldown, the per-invoice cap, the escalation gate, reference integrity, the character cap |
| **Eval harness** | `evals/` | 28 frozen scenarios, a generic runner, `npm run eval`, the committed baseline |
| **Observability** | `collections.decision.v2`, `GET /v1/insights/agents` | provider, model, prompt version, tokens, latency, cost, fallback and override rates |

**Depends on:** the LLM port (`src/llm/`), the delivery port
(`src/delivery/`), S6's public holidays and work week ([`leave.md`](leave.md)),
S8's contact roles ([`crm.md`](crm.md)).

Today the only agent is the CollectionsAgent
(`src/agents/collections.ts` — see [`finance.md`](finance.md) for how it is
triggered). **The guard and the runner are deliberately not collections-shaped**,
because PRD-010's SalesAgent will send messages to people too, and
[conflict C9](../prd/SESSION-PLAN.md) is explicit that two places deciding
whether a message may leave means neither is authoritative.

---

## The one rule everything else bends around

> *Nothing in this PRD changes the fallback guarantee: collections never
> silently stops.* — PRD-002

Every design decision below that looks over-cautious is that sentence:

| Failure | What happens | Why not the obvious alternative |
|---|---|---|
| `agent_settings` unreadable | conservative defaults, agent runs | failing closed is a silent stop |
| Tenant timezone unusable | falls back to `Asia/Kuala_Lumpur`, still enforces a window | treating it as "no window" would allow a 2am send |
| Shipped holiday calendar has no data for the year | **no holidays**, agent runs | "suppress on unknown" stops collections for a whole year, silently, in January |
| No working day within 14 days (a work week of all zeros) | honour the hours, give up on the days | deferring forever is a stop |
| Guardrail blocks a send | the DO alarm is still rescheduled | a cleared alarm ends the loop |
| LLM errors, refuses, or returns junk | deterministic template, `source: "fallback"` recorded | this is the pre-existing guarantee, now audited |

The last column is the point: **a guard that throws is worse than no guard**,
because it takes the agent with it.

---

## Guardrails

Enforced in code, after the LLM returns and before any send — *"not by prompt
instructions the model may ignore"*.

### Two evaluation points, because the rules split

```
                    ┌─────────────── preflight() ───────────────┐
invoice.overdue ──> │ agents.enabled? agent_paused? cooldown?    │
   or the daily     │ per-invoice cap? inside the contact window?│
   alarm            └───────────────────┬───────────────────────┘
                                        │ allowed
                            assemble cross-module context
                                        │
                              decideCollections()  ← the LLM, or the fallback
                                        │
                    ┌────────── applyDecisionGuards() ──────────┐
                    │ escalation gate · reference integrity ·   │
                    │ character cap                             │
                    └───────────────────┬───────────────────────┘
                                        │
                            send → activity → state
```

`preflight` runs **before** the model is asked. Those five checks do not depend on
what the model would say, so a 2am wake or a customer contacted an hour ago costs
two queries and no tokens.

`applyDecisionGuards` runs **after**. These are bounds on the model's own output.

### The rules

| Rule | Default | Configurable | Behaviour when it fires |
|---|---|---|---|
| `agents.enabled` | on | `agent_settings.enabled` | no send; alarm still rescheduled |
| Per-customer pause | off | `customers.agent_paused` (a CRM edit) | same |
| Contact cooldown | 24h | `contact_cooldown_hours` | no send; retry after the cooldown |
| Contact window | 09:00–18:00 tenant local, half-open | `contact_window_*_hour` | **deferred** to the next opening, never dropped |
| Non-working days | suppressed | `suppress_weekends` + `leave_settings.work_week` | deferred to the next working day |
| Public holidays | suppressed | `suppress_holidays` + `public_holidays` | deferred past the whole run of them |
| Reminders per invoice | 5 | `max_reminders_per_invoice` | no send; audited **once per invoice** |
| Escalation gate | ≥ 60 days past due **AND** ≥ 2 prior reminders on that invoice | the days half only | downgraded to `remind`, **and the message replaced** |
| Reference integrity | — | — | a message citing an invoice not in context (or none at all) is replaced with the template |
| Character cap | 2000 | `max_message_chars` | truncated |

**Why the downgrade replaces the message.** A model asked to escalate writes
escalation words. Downgrading the action while sending "final notice — legal
action will follow" would be a downgrade in the audit log only, and the customer
two days late would still have been threatened. The guard swaps in the
deterministic template for the action it settled on.

**Why 60 days.** PRD-002 left the threshold open as a blocking product question.
Malaysian SME payment behaviour runs 60–90 days in practice regardless of stated
terms, so 30 escalates a customer who is behaving normally for the market; 60 is
the bottom of the observed band. Escalation is the irreversible half of the
decision, and the guard can only ever make the model escalate *later* than it
wanted. The reminder-count half is **not** configurable: a tenant setting it to
zero would be a tenant turning the guardrail off.

### Tenant-local time

`company_profile.timezone` (an IANA name, `Asia/Kuala_Lumpur` by default) is
the C6 setting this PRD needed and nothing in `src/` had. It is on the
company-wide settings row rather than an agent-owned one, because SLA targets and
any report with a "today" in it want the same answer.

`guardrails/zone.ts` does the arithmetic on `Intl.DateTimeFormat` — workerd ships
full ICU, so IANA zones, minute offsets (`Asia/Kathmandu`) and DST transitions all
work without a dependency. Zone names are validated against ICU at the settings
endpoint rather than against a hardcoded list: the zone database changes and a
list would not.

### What the guard reuses rather than rebuilds

- **`public_holidays`** (S6) — the shipped Malaysian calendar merged with tenant
  additions and suppressions, via `resolveHolidays`. Resolved on the **national**
  scope: leave asks "is this employee's state closed", collections asks "is the
  country closed", and a Selangor-only holiday is no reason to withhold a
  reminder from a customer in Penang.
- **`leave_settings.work_week`** — which days the company works. One fact, one
  owner, one console.

### What is audited, and what is not

Every firing that changes an outcome emits `guardrail.override.v1`:
`reminder_cap`, `contact_window`, `escalation_gate`, `invoice_reference`,
`message_length`.

`agents_disabled`, `subject_paused` and `contact_cooldown` are logged to the
console only. They are standing tenant instructions rather than the guard
correcting the agent, and the overdue sweep re-checks them daily — an event per
check would write a row a day for every paused customer and drag PRD-002's
override *rate* (a quality signal about the prompt, held to < 10%) towards 100%.
`reminder_cap` does emit, but once per invoice per DO lifetime, for the same
reason.

`guardrail.override.v1` is **agent-agnostic**: `agent`, `subject_type` /
`subject_id`, `subject_ref`. A sales guardrail firing is the same concept, so
S15 passes `agent: "sales"` and a deal id rather than adding a second event type
that would split the metric across two dashboards.

---

## The eval harness

Full guide: [`evals/README.md`](../../evals/README.md). In short:

```bash
npm run eval                                      # configured provider, or the fallback
npm run eval -- --provider=openai --model=gpt-5   # comparison run
npm run eval -- --prompt=broken                   # the failure-mode run
npm run eval -- --write-baseline
```

- **28 frozen JSON fixtures**, schema-validated on load, covering every failure
  mode PRD-002 lists. Expectations are ranges and constraints, never exact
  strings.
- **The runner is generic**, keyed on a decision function. `evals/types.ts` and
  `evals/runner.ts` mention no invoices.
- It runs **the production decision function and the production guardrails** —
  `decideCollections` then `applyDecisionGuards`, the same two calls the Durable
  Object makes. An eval exercising a copy would measure the copy.
- **Not a CI gate** (cost, non-determinism), but a documented pre-merge step for
  any prompt or model change. The harness's own behaviour *is* a gate, in
  `test/evals-harness.test.ts`.

`PROMPT_VERSION` in `src/agents/decision.ts` ties a baseline to a prompt. **Bump
it whenever the prompt changes** and add a line to the changelog in
`evals/README.md`.

---

## Observability

`collections.decision.v2` records how every decision was reached: provider,
model (as served, not as requested), prompt version, token counts, latency, cost
in integer **micro-USD**, the fallback reason, whether a guardrail overrode it and
which rules fired. Money is an integer because per-token prices are far below a
cent and a float would drift across a month of decisions.

An unknown model prices as `null`, never a guess — set
`LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` to price one yourself
(both or neither). `GET /v1/insights/agents` reports how many decisions it could
not price rather than quietly understating spend.

`GET /v1/insights/agents?from=&to=` serves decisions by outcome, fallback rate,
override rate, guardrail firings by rule, spend and tokens, p95 and max latency,
which provider/model/prompt produced the decisions, and monthly buckets. It reads
straight off `events_log` with JSON1 — the decision event is already the audit
record, so a projection table would only be a second thing to keep in sync. That
is also what makes PRD-002's P2 outcome scoring (*"did the invoice get paid within
N days?"*) a query later rather than a migration: `invoice_id` is on the event.

The console's Agent Activity feed badges `fallback` and the guardrails that fired,
gives each override its own row (with the rule named in plain language and when
the send retries), and puts cost, latency and prompt version behind the message
disclosure. Decisions written before S10 still render; the badges simply do not
appear for them.

---

## Settings

| Surface | Gate | Notes |
|---|---|---|
| `GET /v1/settings/agents` | `settings:read` | the resolved policy, with `configured: false` when the tenant is on defaults |
| `PUT /v1/settings/agents` | `agents:write` | partial: an omitted field keeps its value, so an older console form cannot reset a newer bound |
| `PUT /v1/settings/company-profile` | `settings:write` | carries `timezone` |
| `PATCH /v1/customers/:id` | `crm:write` | carries `agent_paused` |

Reads are on the settings axis so a finance or support user can see what the
agent is allowed to do; the write is raised to `agents:write` because it carries
the kill switch. Both resolve to {admin, operator} today — the override records
intent, so that if the settings axis ever widens it does not take the kill switch
with it.

---

## Where to look when something is wrong

| Symptom | Look at |
|---|---|
| A reminder went out at a strange hour | `company_profile.timezone`, then `contact_window_*_hour`; `guardrails/window.ts` decides |
| No reminders at all for a customer | `customers.agent_paused`, then `agent_settings.enabled`, then the reminder cap; all three log a line naming themselves |
| Overrides fired on nearly every decision | the prompt, not the guard. PRD-002 holds the override rate under 10% on the eval suite — above that, the prompt is wrong |
| Spend looks too low | `spend.unpriced_decisions` on `GET /v1/insights/agents` |
| An eval scenario fails after a prompt change | `npm run eval` names the scenarios and the failing check; bump `PROMPT_VERSION` and recapture the baseline once the change is intended |
