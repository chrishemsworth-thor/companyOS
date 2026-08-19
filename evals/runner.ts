import type {
  CheckResult,
  EvalAgent,
  Expectation,
  Observation,
  RunOptions,
  RunReport,
  RunTotals,
  Scenario,
  ScenarioResult,
} from "./types";

/**
 * The generic runner. Give it an agent (scenarios + a decision function) and it
 * produces a report: per-scenario pass/fail, tokens, latency, cost.
 *
 * Nothing here knows what a collections decision is. The checks read
 * `Observation`, which is the whole contract an agent has to meet — so S15's
 * SalesAgent writes scenarios and a `run`, not a second runner.
 */

// ---- the checks ------------------------------------------------------------

function check(name: string, ok: boolean, detail: string): CheckResult {
  return { name, ok, detail };
}

export function checkExpectation(exp: Expectation, obs: Observation): CheckResult[] {
  const checks: CheckResult[] = [];

  if (exp.action) {
    checks.push(
      check(
        "action",
        exp.action.includes(obs.action),
        `expected one of [${exp.action.join(", ")}], got ${obs.action}`,
      ),
    );
  }

  if (exp.risk_score) {
    const { min = 0, max = 100 } = exp.risk_score;
    checks.push(
      check(
        "risk_score",
        obs.risk_score >= min && obs.risk_score <= max,
        `expected ${min}–${max}, got ${obs.risk_score}`,
      ),
    );
  }

  if (exp.channel) {
    checks.push(
      check(
        "channel",
        exp.channel.includes(obs.channel),
        `expected one of [${exp.channel.join(", ")}], got ${obs.channel}`,
      ),
    );
  }

  if (exp.source) {
    checks.push(
      check(
        "source",
        (exp.source as string[]).includes(obs.source),
        `expected one of [${exp.source.join(", ")}], got ${obs.source}`,
      ),
    );
  }

  const m = exp.message;
  if (m) {
    const lower = obs.message.toLowerCase();
    for (const ref of m.mentions_refs ?? []) {
      checks.push(
        check(
          `mentions ${ref}`,
          lower.includes(ref.toLowerCase()),
          `message does not mention ${ref}`,
        ),
      );
    }
    for (const phrase of m.forbids ?? []) {
      checks.push(
        check(
          `omits "${phrase}"`,
          !lower.includes(phrase.toLowerCase()),
          `message contains forbidden phrase "${phrase}"`,
        ),
      );
    }
    for (const phrase of m.requires ?? []) {
      checks.push(
        check(
          `says "${phrase}"`,
          lower.includes(phrase.toLowerCase()),
          `message is missing "${phrase}"`,
        ),
      );
    }
    if (m.max_chars !== undefined) {
      checks.push(
        check(
          "max_chars",
          obs.message.length <= m.max_chars,
          `expected <= ${m.max_chars} chars, got ${obs.message.length}`,
        ),
      );
    }
    if (m.min_chars !== undefined) {
      checks.push(
        check(
          "min_chars",
          obs.message.length >= m.min_chars,
          `expected >= ${m.min_chars} chars, got ${obs.message.length}`,
        ),
      );
    }
  }

  if (exp.overrides) {
    const fired = obs.overrides.map((o) => o.guardrail);
    checks.push(
      check(
        "guardrail fired",
        exp.overrides.expected === fired.length > 0,
        exp.overrides.expected
          ? `expected a guardrail to fire, none did`
          : `expected no guardrail, got [${fired.join(", ")}]`,
      ),
    );
    for (const guardrail of exp.overrides.guardrails ?? []) {
      checks.push(
        check(
          `guardrail ${guardrail}`,
          fired.includes(guardrail),
          `expected ${guardrail} to fire, got [${fired.join(", ") || "none"}]`,
        ),
      );
    }
  }

  return checks;
}

// ---- summaries for the table ----------------------------------------------

function describeExpectation(exp: Expectation): string {
  const parts: string[] = [];
  if (exp.action) parts.push(exp.action.join("|"));
  if (exp.risk_score) parts.push(`risk ${exp.risk_score.min ?? 0}-${exp.risk_score.max ?? 100}`);
  if (exp.channel) parts.push(exp.channel.join("|"));
  if (exp.overrides?.expected) parts.push(`guard:${(exp.overrides.guardrails ?? ["any"]).join("+")}`);
  if (exp.source) parts.push(exp.source.join("|"));
  return parts.join(" · ") || "no assertions";
}

function describeObservation(obs: Observation): string {
  const parts = [obs.action, `risk ${obs.risk_score}`, obs.channel, obs.source];
  if (obs.overrides.length > 0) {
    parts.push(`guard:${obs.overrides.map((o) => o.guardrail).join("+")}`);
  }
  return parts.join(" · ");
}

// ---- the run ---------------------------------------------------------------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: with 28 scenarios the interpolated variant would invent a
  // latency no request actually had.
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
}

export async function runEvals<Ctx, State>(
  agent: EvalAgent<Ctx, State>,
  opts: RunOptions & { prompt_label?: string; only?: readonly string[] } = {},
): Promise<RunReport> {
  const scenarios = opts.only
    ? agent.scenarios.filter((s) => opts.only!.includes(s.id))
    : agent.scenarios;

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runOne(agent, scenario, opts));
  }

  const observed = results.map((r) => r.observation).filter((o): o is Observation => o !== null);
  const latencies = observed.map((o) => o.latency_ms);
  // A total is only honest if every priced call had a rate. One unknown model
  // makes the sum an understatement, and an understated spend figure is worse
  // than no figure in a pricing conversation.
  const anyUnpriced = observed.some((o) => o.source === "llm" && o.cost_micros === null);
  const totals: RunTotals = {
    scenarios: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    gaps: results.filter((r) => r.status === "gap").length,
    errors: results.filter((r) => r.status === "error").length,
    input_tokens: observed.reduce((sum, o) => sum + (o.input_tokens ?? 0), 0),
    output_tokens: observed.reduce((sum, o) => sum + (o.output_tokens ?? 0), 0),
    cost_micros: anyUnpriced
      ? null
      : observed.reduce((sum, o) => sum + (o.cost_micros ?? 0), 0),
    p95_latency_ms: percentile(latencies, 95),
    max_latency_ms: latencies.length > 0 ? Math.max(...latencies) : 0,
  };

  // A canned response is not a model run: a keyless suite still exercises the
  // guardrail scenarios, and reporting that as "live anthropic" would put a
  // fictional model id on a baseline.
  const live = observed.find((o) => o.source === "llm" && !o.canned);
  return {
    agent: agent.name,
    mode: live ? "live" : "fallback",
    provider: live?.provider ?? null,
    model: live?.model ?? null,
    prompt_version: observed[0]?.prompt_version ?? "unknown",
    prompt_label: opts.prompt_label ?? "default",
    scenarios: results,
    totals,
    ok: totals.failed === 0 && totals.errors === 0,
  };
}

async function runOne<Ctx, State>(
  agent: EvalAgent<Ctx, State>,
  scenario: Scenario<Ctx, State>,
  opts: RunOptions,
): Promise<ScenarioResult> {
  const base = {
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    expected: describeExpectation(scenario.expect),
    fixture_only: scenario.fixture_only,
  };
  let observation: Observation;
  try {
    observation = await agent.run(scenario, opts);
  } catch (err) {
    // An agent that throws is a failure of the harness's central promise —
    // "must not crash" is one of PRD-002's own scenarios — so it is reported,
    // never swallowed.
    return {
      ...base,
      status: "error",
      actual: "threw",
      checks: [],
      observation: null,
      error: String(err),
    };
  }

  const checks = checkExpectation(scenario.expect, observation);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    return { ...base, status: "pass", actual: describeObservation(observation), checks, observation };
  }

  // A declared fallback blind spot, exercised by the fallback, is a `gap`: a
  // documented, machine-checked fact rather than a failure. Anything else is a
  // failure — including the same scenario missing when a model ran it, and any
  // check the fixture did not declare as a blind spot.
  const excused = scenario.fallback.missing;
  const isDeclaredGap =
    observation.source === "fallback" &&
    !scenario.fallback.handled &&
    (excused === undefined || failed.every((c) => excused.includes(c.name)));
  return {
    ...base,
    status: isDeclaredGap ? "gap" : "fail",
    actual: describeObservation(observation),
    checks,
    observation,
    gap_note: isDeclaredGap ? scenario.fallback.note : undefined,
  };
}
