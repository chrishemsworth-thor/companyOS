import {
  applyDecisionGuards,
  DEFAULT_AGENT_POLICY,
  type AgentPolicy,
  type SendContext,
} from "../../src/agents/guardrails";
import {
  decideCollections,
  templateMessage,
  type AgentStateSummary,
  type CollectionsContext,
} from "../../src/agents/decision";
import type { LlmProvider, StructuredResult } from "../../src/llm/types";
import { parseScenario, type CollectionsScenarioFixture } from "../schema";
import type { EvalAgent, Observation, RunOptions, Scenario } from "../types";

/**
 * The CollectionsAgent, plugged into the generic runner.
 *
 * It runs **the production decision function and the production guardrails** —
 * `decideCollections` then `applyDecisionGuards`, the same two calls the Durable
 * Object makes. That is the point: an eval that exercised a copy of the logic
 * would tell you the copy did not regress.
 *
 * What it deliberately does not run is the pre-send gate (`preflight`): the kill
 * switches, the cooldown, the per-invoice cap and the contact window do not
 * depend on the model at all, so putting them in a model-comparison suite would
 * measure nothing. They are covered in `test/agent-guardrails.test.ts`.
 */

export type CollectionsScenario = Scenario<CollectionsContext, AgentStateSummary>;

/** Every fixture in `evals/scenarios/collections/`, validated on load. */
const fixtures = import.meta.glob<unknown>("../scenarios/collections/*.json", {
  eager: true,
  import: "default",
});

export function loadCollectionsScenarios(): CollectionsScenario[] {
  const scenarios = Object.entries(fixtures)
    .map(([path, raw]) => parseScenario(raw, path))
    .sort((a, b) => a.id.localeCompare(b.id));

  const ids = new Set<string>();
  for (const s of scenarios) {
    if (ids.has(s.id)) throw new Error(`duplicate eval scenario id: ${s.id}`);
    ids.add(s.id);
  }
  return scenarios as CollectionsScenario[];
}

/** A stub provider that answers with a fixed response — how a scenario pins the
 * model's output to exercise a guardrail. */
function cannedProvider(response: unknown): LlmProvider {
  return {
    name: "anthropic",
    completeStructured: async (): Promise<StructuredResult> => ({
      output: response,
      model: "canned",
      // No usage: a canned response cost nothing, and reporting an invented
      // token count would pollute the run's totals.
      usage: null,
    }),
  };
}

/** What PRD-002 calls "malformed LLM response": shaped like JSON, not like a
 * decision. The Zod gate must reject it and the fallback must fire. */
const MALFORMED_RESPONSE = {
  risk: "very high",
  action: "sue_them",
  message: 42,
};

/**
 * The escalation gate's non-configurable half (PRD-002: "AND >= 2 prior
 * reminders"), mirrored from the Durable Object.
 */
const MIN_REMINDERS_BEFORE_ESCALATION = 2;

function policyFor(scenario: CollectionsScenario): AgentPolicy {
  return { ...DEFAULT_AGENT_POLICY, ...(scenario.policy as Partial<AgentPolicy> | undefined) };
}

export function collectionsEvalAgent(
  liveProvider: LlmProvider | null,
  scenarios: CollectionsScenario[] = loadCollectionsScenarios(),
): EvalAgent<CollectionsContext, AgentStateSummary> {
  return {
    name: "collections",
    scenarios,
    async run(scenario, opts: RunOptions): Promise<Observation> {
      const canned = scenario.llm.mode !== "live";
      const provider =
        scenario.llm.mode === "canned"
          ? cannedProvider(scenario.llm.response)
          : scenario.llm.mode === "malformed"
            ? cannedProvider(scenario.llm.response ?? MALFORMED_RESPONSE)
            : liveProvider;

      const outcome = await decideCollections(provider, scenario.context, scenario.state, {
        system: opts.system,
      });

      const policy = policyFor(scenario);
      const target = scenario.context.overdue_invoices[0];
      const validRefs = scenario.context.overdue_invoices.map((i) => i.invoice_id);
      const ctx: SendContext = {
        agent: "collections",
        subject_type: "customer",
        subject_id: scenario.context.customer?.customer_id ?? "unknown",
        channel: outcome.decision.channel,
        at: Date.parse(scenario.now),
        last_contact_at: scenario.state.last_contact
          ? Date.parse(scenario.state.last_contact)
          : null,
        paused: false,
        sends_for_ref: scenario.state.reminders_sent,
        ref: target?.invoice_id ?? null,
      };

      const { decision, overrides } = applyDecisionGuards(policy, ctx, outcome.decision, {
        valid_refs: validRefs,
        fallback_message: (action) =>
          templateMessage(scenario.context, action as "remind" | "escalate" | "wait"),
        escalation: {
          action: "escalate",
          downgrade_to: "remind",
          days_past_due: Math.max(
            0,
            ...scenario.context.overdue_invoices.map((i) => i.days_overdue),
          ),
          prior_sends: scenario.state.reminders_sent,
          min_prior_sends: MIN_REMINDERS_BEFORE_ESCALATION,
        },
      });

      return {
        action: decision.action,
        risk_score: decision.risk_score,
        channel: decision.channel,
        message: decision.message,
        source: outcome.source,
        provider: outcome.provider,
        model: outcome.model,
        prompt_version: outcome.prompt_version,
        input_tokens: outcome.input_tokens,
        output_tokens: outcome.output_tokens,
        latency_ms: outcome.latency_ms,
        cost_micros: outcome.cost_micros,
        overrides: overrides.map((o) => ({
          guardrail: o.guardrail,
          outcome: o.outcome,
          detail: o.detail,
        })),
        valid_refs: validRefs,
        canned,
        fallback_reason: outcome.fallback_reason,
      };
    },
  };
}
