# `evals/` — the agent evaluation harness

**PRD:** [002](../docs/prd/PRD-002-agent-portability-and-eval.md) · shipped in S10

> *"There is no way to tell whether a model, prompt, or provider change made
> collections better or worse. Today a provider swap is a silent, unmeasured bet
> placed on customers' money and customer relationships."* — PRD-002

This is the answer to that: 28 frozen scenarios, run against the configured
provider, with a pass/fail result and a committed baseline.

## Running it

```bash
npm run eval                                  # the configured provider, or the fallback
npm run eval -- --provider=openai --model=gpt-5   # a comparison run
npm run eval -- --prompt=broken               # the deliberately broken prompt
npm run eval -- --only=c14-guardrail-downgrades-early-escalation
npm run eval -- --write-baseline              # writes evals/baseline/<agent>-<model>.json
```

**With no LLM key configured the suite still runs**, against the deterministic
fallback. That is a real run, not a skipped one: PRD-002 requires the harness to
report which scenarios the fallback handles, and `evals/baseline/collections-fallback.json`
is that result, committed.

`npm run eval` is **not a CI gate** — it costs money and it is non-deterministic.
It is a **documented pre-merge step for any prompt or model change**. The
harness's own behaviour is a gate, in `test/evals-harness.test.ts`, because that
part is deterministic and free.

## Why it runs inside the Workers pool

`npm run eval` shells into vitest with `vitest.eval.config.ts`, which uses the
same `@cloudflare/vitest-pool-workers` runtime the tests use. So the decision
function, the guardrails and the timezone arithmetic execute on workerd — the
runtime that serves production — and the harness needs no new dependency to do
it. `scripts/run-evals.mjs` does the three things a Worker cannot: parse argv,
turn flags into bindings, and write the baseline file from the run's output.

## What a scenario is

One JSON file per scenario in `scenarios/collections/`, validated against
`schema.ts` on load. Adding a scenario means adding a file.

```jsonc
{
  "id": "c01-first-contact-one-day-overdue",
  "title": "...",
  "covers": "which PRD-002 failure mode this is",   // printed when it fails
  "now": "2026-08-19T04:00:00Z",                    // 12:00 Wednesday in Kuala Lumpur
  "llm": { "mode": "live" },                        // live | canned | malformed
  "state": { "escalation_stage": "none", "reminders_sent": 0, "last_contact": null },
  "context": { /* a full CollectionsContext */ },
  "expect": { /* ranges and constraints, never exact strings */ },
  "fallback": { "handled": true }
}
```

**Fixtures, not generated from `seed:sample`.** PRD-002 leaves this open; the
harness commits fixtures because a baseline can only be compared against a
frozen context, and a scenario that drifts when the seed changes is not a
regression test. The cost is that a fixture can rot against the context type, so
every fixture is schema-validated on load and in the test suite.

**`llm.mode`** decides where the decision comes from:

| mode | behaviour | what it is for |
|---|---|---|
| `live` | asks the configured provider; with no key, the deterministic fallback runs | judgement scenarios |
| `canned` | a stub provider returns the fixture's exact response | guardrail scenarios — they must hold with or without a key |
| `malformed` | the stub returns something the Zod gate rejects | proving the fallback fires |

**`fallback.handled`** is how the suite stays honest about the heuristic. The
deterministic fallback cannot satisfy the judgement scenarios, so a scenario
declares whether it expects the fallback to pass. `missing: ["risk_score"]`
narrows that excuse to named checks — which matters: a scenario whose point is
"never escalate" must keep failing if the fallback ever escalates, even though
its risk band is a known blind spot. A declared blind spot is reported as a
`GAP`, with its note, and does not fail the run. An undeclared miss is a `FAIL`.

## What the fallback baseline says today

26 pass, 2 declared gaps, 0 failures. The two gaps are judgement the heuristic
cannot do:

- **`c05`** — a payment arrived this morning and the sweep has not caught up. The
  heuristic reminds; a model should wait.
- **`c08`** — a disputed invoice with a credit note pending. The heuristic
  reminds for the full amount, because it has no notion of a dispute.

Both are about the *action*, not the score, and both are declared in their
fixture with a note. Neither is fixable by arithmetic.

### The finding this harness paid for

The first fallback run turned up a real defect: **the risk score saturated.** It
was `min(100, days_overdue * 5 + reminders * 10)`, so anything past about 20 days
scored 100 and a 20-day-late invoice from a customer who had paid twelve of
twelve on time read identically to a 200-day write-off from somebody who had
never paid at all.

It is now weighted by how the customer actually pays
(`assessRisk` in `src/agents/decision.ts`):

```
score = (lateness + ignored reminders) × reliability factor
```

- **lateness** — a curve, not a line, capped at 55 so lateness alone can never
  produce a maximum score. Shaped so 60–90 days reads as notable rather than
  alarming, which is the Malaysian norm.
- **ignored reminders** — up to 20. The customer's own behaviour in response to
  us, which is the strongest evidence a heuristic has.
- **reliability factor** — from DSO against the customer's *own* terms:
  `always_pays` 0.55, `pays_late` 0.75, `chronically_late` 0.9, `unproven` 1.0,
  `never_paid` 1.25. Nothing settled *and* no chance to settle yet is `unproven`,
  not `never_paid`: unknown must not read as bad.

The scenarios show the gradient: `c06` (reliable, 20 days late) scores **7**,
`c03` (unproven, 30 days) **27**, `c24` (chronically late but always pays, 31
days) **18**, and `c04` (never paid, 90 days, three reminders ignored) **75**.

**Two limitations, recorded rather than hidden:**

1. **Exposure is not in the score.** Amount owed obviously belongs in a risk
   judgement, but invoices carry their own currency and one context can hold
   several; scoring MYR 5,000 and SGD 5,000 the same would be worse than leaving
   money out until there is a base-currency conversion to do it properly. The
   model sees the amounts and can weigh them.
2. **Deviation from the customer's own habit is not modelled.** A customer 75
   days late against their own 62-day average is treated the same as one 75 days
   late on 30-day terms. That is the more sophisticated signal, and it is the
   obvious next refinement.

The factors are uncalibrated against real Malaysian SME behaviour and are meant
to be argued with. They are named constants for exactly that reason, and this
suite is how a change to them gets checked.

## Prompt versions

Every decision records `prompt_version` (`collections.decision.v2`), and a
baseline is only meaningful for the version it was captured under. **Bump
`PROMPT_VERSION` in `src/agents/decision.ts` whenever the system prompt or the
prompt builder changes, and add a line here.**

| Version | Change |
|---|---|
| `collections-2026-08-19` | First versioned prompt. Contents as shipped through S8: tone rules, escalation guidance, contact-role addressing (PRD-003), account-health as a tone signal only. |
| `collections-2026-08-20` | Added the payment record — DSO against the customer's own terms — to the context, and a rule telling the model to weigh it rather than the days overdue alone ("in Malaysia, paying 60–90 days after invoice is common and is not by itself alarming"). Same change as the deterministic score's reliability weighting, so the two paths reason from the same fact. |

`prompts/broken.ts` holds the deliberately broken prompt for PRD-002's second
acceptance criterion — broken the way a real regression is broken (a constraint
deleted, a tone inverted), not gibberish. It only changes anything against a live
model, so the harness's failure *reporting* is asserted separately, against a
canned bad decision, in `test/evals-harness.test.ts`.

## What is not in here

- **The pre-send gate.** The kill switches, the 24h cooldown, the per-invoice cap
  and the contact window do not depend on the model at all, so putting them in a
  model-comparison suite would measure nothing. They are covered in
  `test/agent-guardrails.test.ts` and `test/agent-guardrails-window.test.ts`.
- **Outcome scoring** (did the invoice get paid within N days?). PRD-002 P2:
  needs real customer data. `collections.decision.v2` keeps decisions linked to
  invoices so this becomes a query later, not a migration.

## Adding another agent

The runner is keyed on a decision function, not on collections. To plug in a
second agent — S15's SalesAgent is the next one, and
[conflict C9](../docs/prd/SESSION-PLAN.md) makes it S15's job — supply:

1. scenarios (fixtures + a schema, as `scenarios/<agent>/`);
2. a `run(scenario, opts)` that calls **your production decision function and
   the shared guardrails**, and returns an `Observation`.

Everything else — the checks, the table, the gaps, the p95, the baseline — is
shared, and `types.ts` deliberately mentions no invoices. What S15 must not do is
write a second runner: PRD-002 requires one generic runner, and two would mean
two definitions of "passing".
