import { describe, it, expect } from "vitest";
import { collectionsEvalAgent, loadCollectionsScenarios } from "../evals/agents/collections";
import { runEvals } from "../evals/runner";
import { formatReport, toBaseline } from "../evals/report";
import { collectionsScenarioSchema } from "../evals/schema";
import { PROMPTS } from "../evals/prompts/broken";
import type { LlmProvider, StructuredResult } from "../src/llm/types";
import committedBaseline from "../evals/baseline/collections-fallback.json";

/**
 * The eval harness's own acceptance criteria (PRD-002 § "Evaluation harness"),
 * tested deterministically.
 *
 * The eval *run* is not a CI gate — PRD-002 is explicit that it costs money and
 * is non-deterministic. The harness is a different thing: whether it counts
 * correctly, names its failures, reports cost and p95, and still matches its
 * committed baseline is all deterministic, and all of it is checked here.
 */

/** Answers with a fixed decision, so a run is repeatable without a key. */
function stubProvider(response: unknown, usage = { input_tokens: 800, output_tokens: 120 }): LlmProvider {
  return {
    name: "anthropic",
    completeStructured: async (): Promise<StructuredResult> => ({
      output: response,
      model: "claude-opus-4-8",
      usage,
    }),
  };
}

describe("the frozen scenario set", () => {
  const scenarios = loadCollectionsScenarios();

  it("carries 25–30 scenarios, as PRD-002 requires", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(25);
    expect(scenarios.length).toBeLessThanOrEqual(30);
  });

  it("validates every fixture against the scenario schema", () => {
    // Fixtures are frozen JSON, so nothing type-checks them at build time. A
    // context that silently lost its invoices would make a scenario pass for
    // the wrong reason.
    for (const scenario of scenarios) {
      expect(collectionsScenarioSchema.safeParse(scenario).success, scenario.id).toBe(true);
    }
  });

  it("covers every failure mode PRD-002 lists", () => {
    const ids = scenarios.map((s) => s.id).join(" ");
    for (const mode of [
      "first-contact", // 1 day overdue, first contact, good history
      "ninety-days-three-reminders", // ignored reminders → escalate
      "paid-today", // payment received today, still flagged
      "live-deal", // open high-value deal, small overdue
      "support-ticket", // open unresolved ticket → softer
      "disputed-credit-note", // disputed invoice (fixture-only, C6)
      "partial-payment", // remind for the remainder
      "degenerate-empty-context", // must not crash
      "malformed-llm-response", // deterministic fallback fires
    ]) {
      expect(ids, `no scenario covers ${mode}`).toContain(mode);
    }
  });

  it("states, for every scenario, whether the deterministic fallback handles it", () => {
    for (const scenario of scenarios) {
      expect(typeof scenario.fallback.handled, scenario.id).toBe("boolean");
      // A declared blind spot has to say what it is, or the report is a shrug.
      if (!scenario.fallback.handled) {
        expect(scenario.fallback.note, scenario.id).toBeTruthy();
      }
    }
  });

  it("flags the credit-note scenario as fixture-only, per conflict C6", () => {
    const disputed = scenarios.find((s) => s.id.includes("disputed-credit-note"));
    expect(disputed?.fixture_only?.blocked_by).toContain("S13");
    // The pending credit note is expressed through a real context field, so the
    // fixture stays valid without inventing a schema the agent cannot fill.
    expect(disputed?.context.recent_activities.map((a) => a.kind)).toContain("credit_note_pending");
  });

  it("does not assert on exact message strings anywhere", () => {
    // PRD-002: "Expectations are ranges and constraints, not exact strings."
    for (const scenario of scenarios) {
      const m = scenario.expect.message;
      if (!m) continue;
      for (const phrase of [...(m.requires ?? []), ...(m.forbids ?? [])]) {
        expect(phrase.length, `${scenario.id} asserts a whole sentence`).toBeLessThan(40);
      }
    }
  });
});

describe("a run against the deterministic fallback", () => {
  it("passes, and names the scenarios the fallback cannot handle", async () => {
    // PRD-002: "Given no LLM key configured, then eval runs against the
    // deterministic fallback and reports which scenarios the fallback handles."
    const report = await runEvals(collectionsEvalAgent(null));

    expect(report.mode).toBe("fallback");
    expect(report.totals.failed).toBe(0);
    expect(report.totals.errors).toBe(0);
    expect(report.ok).toBe(true);

    const gaps = report.scenarios.filter((s) => s.status === "gap");
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) expect(gap.gap_note, gap.id).toBeTruthy();
    // The report names them, rather than hiding them in a pass count.
    const text = formatReport(report);
    expect(text).toContain("Fallback gaps (declared, not failures)");
    for (const gap of gaps) expect(text).toContain(gap.id);
  });

  it("matches the baseline committed to the repo", async () => {
    // PRD-002's first eval criterion, for the path CI can actually run: the
    // deterministic one. A change in the fallback's behaviour, or in the
    // guardrails it runs through, shows up here as a diff against this file.
    const report = await runEvals(collectionsEvalAgent(null));
    expect(toBaseline(report)).toEqual(committedBaseline);
  });

  it("never crashes on the degenerate context", async () => {
    const report = await runEvals(collectionsEvalAgent(null), {
      only: ["c10-degenerate-empty-context"],
    });
    expect(report.totals.errors).toBe(0);
    expect(report.scenarios[0]!.status).toBe("pass");
    expect(report.scenarios[0]!.observation!.source).toBe("fallback");
  });

  it("falls back deterministically on a malformed model response", async () => {
    // The scenario supplies the malformed response, so this holds with or
    // without a key configured — which is the point of the mode.
    const report = await runEvals(collectionsEvalAgent(stubProvider({ looks: "fine" })), {
      only: ["c11-malformed-llm-response"],
    });
    const obs = report.scenarios[0]!.observation!;
    expect(obs.source).toBe("fallback");
    expect(obs.fallback_reason).toBeTruthy();
    expect(report.scenarios[0]!.status).toBe("pass");
  });
});

describe("a run that goes wrong", () => {
  /** Every scenario decided badly — the shape a broken prompt produces. */
  const BAD_DECISION = {
    risk_score: 100,
    action: "escalate",
    channel: "email",
    message: "Pay now or we will take legal action. Our lawyer is instructed.",
  };

  it("fails, and names exactly which scenarios failed", async () => {
    // PRD-002: "Given a deliberately broken prompt, then the eval fails and
    // names which scenarios." A prompt only changes behaviour through a model,
    // so the testable half is the harness's reporting: given bad decisions, the
    // run must fail and identify them. The live-model half is
    // `npm run eval -- --prompt=broken`.
    const report = await runEvals(collectionsEvalAgent(stubProvider(BAD_DECISION)), {
      only: [
        "c01-first-contact-one-day-overdue",
        "c25-first-contact-large-amount",
        "c22-nothing-due",
      ],
      prompt_label: "broken",
    });

    expect(report.ok).toBe(false);
    const failed = report.scenarios.filter((s) => s.status === "fail").map((s) => s.id);
    expect(failed).toContain("c01-first-contact-one-day-overdue");
    expect(failed).toContain("c25-first-contact-large-amount");

    const text = formatReport(report);
    expect(text).toContain("FAILED:");
    for (const id of failed) expect(text).toContain(id);
    // And it says WHY, per check, not just that something is red.
    expect(text).toMatch(/✗ (action|omits|mentions|risk_score)/);
  });

  it("ships a broken prompt to run that with, for a live comparison", () => {
    // The file itself is the deliverable for the live half of the criterion.
    expect(PROMPTS.broken).toBeTruthy();
    expect(PROMPTS.broken).toMatch(/legal action/i);
    expect(PROMPTS.broken).not.toContain("Never invent invoice numbers");
  });

  it("reports a scenario that throws as an error, rather than swallowing it", async () => {
    const exploding: LlmProvider = {
      name: "anthropic",
      completeStructured: async () => {
        throw new Error("boom");
      },
    };
    // A provider that throws is caught by the decision function and falls back —
    // that is the fallback guarantee. So to test the harness's own error path,
    // break the agent instead.
    const agent = collectionsEvalAgent(exploding);
    const broken = {
      ...agent,
      run: async () => {
        throw new Error("harness exploded");
      },
    };
    const report = await runEvals(broken, { only: ["c01-first-contact-one-day-overdue"] });
    expect(report.scenarios[0]!.status).toBe("error");
    expect(report.scenarios[0]!.error).toContain("harness exploded");
    expect(report.ok).toBe(false);
  });
});

describe("what a run reports", () => {
  it("reports total cost and p95 latency", async () => {
    // PRD-002's fourth eval criterion.
    const report = await runEvals(collectionsEvalAgent(stubProvider({
      risk_score: 30,
      action: "remind",
      channel: "email",
      message: "Gentle reminder about invoice inv_eval_0101.",
    })), { only: ["c01-first-contact-one-day-overdue", "c02-first-contact-no-history"] });

    expect(report.totals.input_tokens).toBe(1_600);
    expect(report.totals.output_tokens).toBe(240);
    // 800 in + 120 out on claude-opus-4-8 ($5/$25 per MTok) = 4,000 + 3,000
    // micro-USD per call, twice.
    expect(report.totals.cost_micros).toBe(14_000);
    expect(report.totals.p95_latency_ms).toBeGreaterThanOrEqual(0);

    const text = formatReport(report);
    expect(text).toContain("total cost $0.014000");
    expect(text).toContain("p95 latency");
    expect(text).toContain("tok in/out");
  });

  it("refuses to total a cost when any call had no known rate", async () => {
    // An understated spend figure is worse than no figure in a pricing
    // conversation, so one unpriced model makes the total null rather than a
    // partial sum.
    const report = await runEvals(
      collectionsEvalAgent({
        name: "openai",
        completeStructured: async () => ({
          output: { risk_score: 30, action: "remind", channel: "email", message: "invoice inv_eval_0101" },
          model: "some-unpriced-model",
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      }),
      { only: ["c01-first-contact-one-day-overdue"] },
    );
    expect(report.scenarios[0]!.observation!.cost_micros).toBeNull();
    expect(report.totals.cost_micros).toBeNull();
    expect(formatReport(report)).toContain("total cost —");
  });

  it("records provider, model and prompt version on every observation", async () => {
    const report = await runEvals(
      collectionsEvalAgent(stubProvider({
        risk_score: 30,
        action: "remind",
        channel: "email",
        message: "invoice inv_eval_0101 is overdue",
      })),
      { only: ["c01-first-contact-one-day-overdue"] },
    );
    expect(report.scenarios[0]!.observation).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-8",
      prompt_version: "collections-2026-08-19",
      canned: false,
    });
    expect(report.mode).toBe("live");
  });

  it("does not report a canned guardrail scenario as a live model run", async () => {
    // Otherwise a keyless run would stamp a fictional model id on a baseline.
    const report = await runEvals(collectionsEvalAgent(null), {
      only: ["c14-guardrail-downgrades-early-escalation"],
    });
    expect(report.scenarios[0]!.observation!.canned).toBe(true);
    expect(report.mode).toBe("fallback");
    expect(report.model).toBeNull();
  });
});

describe("the guardrails, through the harness", () => {
  it("runs the production guardrails, not a copy", async () => {
    // The guardrail scenarios pin the model's output and assert the guard
    // corrected it — the same `applyDecisionGuards` the Durable Object calls.
    const report = await runEvals(collectionsEvalAgent(null), {
      only: [
        "c14-guardrail-downgrades-early-escalation",
        "c15-guardrail-rejects-hallucinated-invoice",
        "c16-guardrail-truncates-long-message",
        "c20-long-overdue-one-reminder-cannot-escalate",
        "c21-below-threshold-cannot-escalate",
      ],
    });
    expect(report.totals.failed).toBe(0);
    const fired = report.scenarios.flatMap((s) =>
      (s.observation?.overrides ?? []).map((o) => o.guardrail),
    );
    expect(new Set(fired)).toEqual(
      new Set(["escalation_gate", "invoice_reference", "message_length"]),
    );
  });

  it("honours a scenario's own guardrail policy", async () => {
    // c16 caps messages at 600 chars via the fixture's `policy` block, so a
    // policy override reaching the guard is what makes that scenario mean
    // something.
    const report = await runEvals(collectionsEvalAgent(null), {
      only: ["c16-guardrail-truncates-long-message"],
    });
    expect(report.scenarios[0]!.observation!.message.length).toBe(600);
  });
});
