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

22 pass, 6 declared gaps, 0 failures. The gaps are worth reading — they are the
first thing this harness found:

- **`c05`, `c08`** — the heuristic has no notion of "already paid" or "disputed",
  so it reminds where a model should wait. Both are judgement, not arithmetic.
- **`c03`, `c06`, `c07`, `c24`** — the fallback's **risk score saturates**.
  It is `min(100, days_overdue * 5 + reminders * 10)`, so anything past about 20
  days scores 100, and it cannot land in a band. A 20-day-late invoice from a
  customer who always pays reads as identical to a 200-day write-off.

That second one is a real defect in the fallback, surfaced by the eval rather
than by a customer — which is the point of the exercise. **It is deliberately
not fixed in S10**: re-tuning collections' risk curve changes agent behaviour and
wants a product decision, not a guardrail session. The action and message
expectations on those scenarios stay enforced, so the gap is scoped to the score.

## Prompt versions

Every decision records `prompt_version` (`collections.decision.v2`), and a
baseline is only meaningful for the version it was captured under. **Bump
`PROMPT_VERSION` in `src/agents/decision.ts` whenever the system prompt or the
prompt builder changes, and add a line here.**

| Version | Change |
|---|---|
| `collections-2026-08-19` | First versioned prompt. Contents as shipped through S8: tone rules, escalation guidance, contact-role addressing (PRD-003), account-health as a tone signal only. |

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
