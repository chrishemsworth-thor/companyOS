/**
 * The evaluation harness's vocabulary — deliberately agent-agnostic.
 *
 * PRD-002 requires "a generic runner keyed on an agent's decision function so
 * future agents plug in", and SESSION-PLAN C9 makes generalising it further
 * S15's job. So nothing in this file mentions invoices, collections, or
 * reminders: an agent supplies scenarios and a `run` function, and everything
 * else — the checks, the table, the baseline, the p95 — is shared.
 */

/**
 * What a scenario asserts. **Ranges and constraints, never exact strings**
 * (PRD-002): LLM output is non-deterministic, and a test that pins the wording
 * measures the wording rather than the behaviour.
 */
export interface Expectation {
  /** The decision must be one of these actions. */
  action?: string[];
  risk_score?: { min?: number; max?: number };
  channel?: string[];
  source?: ("llm" | "fallback")[];
  message?: {
    /** Each of these references must appear — "mentions the correct invoice". */
    mentions_refs?: string[];
    /** Case-insensitive phrases that must NOT appear (legal threats, etc.). */
    forbids?: string[];
    /** Case-insensitive phrases that must appear. */
    requires?: string[];
    max_chars?: number;
    min_chars?: number;
  };
  /** Whether a guardrail was expected to fire, and optionally which. */
  overrides?: { expected: boolean; guardrails?: string[] };
}

/** How the model is supplied for one scenario. */
export type LlmMode =
  /** Ask the configured provider; with no key, the deterministic fallback runs. */
  | { mode: "live" }
  /** Return this exact response — how a guardrail scenario is expressed. */
  | { mode: "canned"; response: unknown }
  /** Return something the schema rejects; the fallback must fire. */
  | { mode: "malformed"; response?: unknown };

export interface Scenario<Ctx, State> {
  id: string;
  title: string;
  /** Which PRD-002 failure mode this covers. Printed when it fails. */
  covers: string;
  /** The instant the scenario is evaluated at, ISO. */
  now: string;
  llm: LlmMode;
  state: State;
  context: Ctx;
  expect: Expectation;
  /**
   * Whether the **deterministic fallback** is expected to satisfy `expect`.
   *
   * PRD-002's third eval criterion asks the harness to report "which scenarios
   * the fallback handles", and the honest answer is that a heuristic cannot
   * satisfy the judgement scenarios. A scenario declared `handled: false` is
   * reported as a `gap` with its note when the fallback runs it, and does not
   * fail the run; one declared `handled: true` that misses is a failure.
   *
   * `missing` narrows that excuse to named checks, which matters more than it
   * sounds: a scenario whose whole point is "never escalate" must keep failing
   * if the fallback ever escalates, even though its risk-score band is a known
   * blind spot. Omit `missing` to excuse the scenario wholesale.
   */
  fallback: { handled: boolean; note?: string; missing?: string[] };
  /**
   * Set when the scenario's context describes something the live agent cannot
   * yet assemble. SESSION-PLAN C6: the disputed-invoice scenario needs S13's
   * credit notes, so it ships as a fixture-only context.
   */
  fixture_only?: { blocked_by: string; note: string };
  /** Per-scenario guardrail policy overrides, if the scenario is about one. */
  policy?: Record<string, number | boolean>;
}

/** What actually happened, in terms the shared checks understand. */
export interface Observation {
  action: string;
  risk_score: number;
  channel: string;
  message: string;
  source: "llm" | "fallback";
  provider: string | null;
  model: string | null;
  prompt_version: string;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  cost_micros: number | null;
  /** Guardrail firings, in the order they fired. */
  overrides: { guardrail: string; outcome: string; detail: string }[];
  /** The references that were genuinely in the context. */
  valid_refs: string[];
  /**
   * True when the "model" was a canned fixture response rather than a real
   * provider. Canned scenarios are how a guardrail is exercised without a key,
   * so they must not make a keyless run report itself as a live model run.
   */
  canned: boolean;
  /** Why the fallback fired, when it did. */
  fallback_reason: string | null;
}

export interface RunOptions {
  /** Override the agent's system prompt — how `--prompt=broken` works. */
  system?: string;
  /** Provider name to report when the configured provider is used. */
  provider?: string;
  model?: string;
}

/** An agent under evaluation: scenarios plus one decision function. */
export interface EvalAgent<Ctx, State> {
  name: string;
  scenarios: readonly Scenario<Ctx, State>[];
  /** Decide, then apply the same guardrails the live agent applies. */
  run(scenario: Scenario<Ctx, State>, opts: RunOptions): Promise<Observation>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export type ScenarioStatus = "pass" | "fail" | "gap" | "error";

export interface ScenarioResult {
  id: string;
  title: string;
  covers: string;
  status: ScenarioStatus;
  /** One-line summary of what was expected, for the table. */
  expected: string;
  /** One-line summary of what happened. */
  actual: string;
  checks: CheckResult[];
  observation: Observation | null;
  fixture_only?: { blocked_by: string; note: string };
  /** Present on a `gap`: the fallback's documented blind spot. */
  gap_note?: string;
  error?: string;
}

export interface RunTotals {
  scenarios: number;
  passed: number;
  failed: number;
  /** Declared fallback blind spots that the fallback did indeed miss. */
  gaps: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  /** Null when any priced call had no known rate — a partial total would lie. */
  cost_micros: number | null;
  p95_latency_ms: number;
  max_latency_ms: number;
}

export interface RunReport {
  agent: string;
  /** "live" when at least one scenario reached a real provider. */
  mode: "live" | "fallback";
  provider: string | null;
  model: string | null;
  prompt_version: string;
  prompt_label: string;
  scenarios: ScenarioResult[];
  totals: RunTotals;
  /** True when nothing failed and nothing errored. Gaps do not fail a run. */
  ok: boolean;
}
