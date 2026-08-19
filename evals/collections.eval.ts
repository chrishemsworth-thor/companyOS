import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getLlmProvider } from "../src/llm";
import { collectionsEvalAgent } from "./agents/collections";
import { formatReport, machineBlock } from "./report";
import { PROMPTS } from "./prompts/broken";
import { runEvals } from "./runner";

/**
 * `npm run eval` — the frozen collections scenario suite.
 *
 * It runs inside the Workers pool rather than bare node, deliberately: the
 * decision function, the guardrails and the timezone arithmetic then execute on
 * the same runtime that serves production, and the harness needs no new
 * dependency to do it. `scripts/run-evals.mjs` is the CLI in front of it — it
 * parses `--provider`, `--model`, `--prompt` and `--write-baseline`, passes them
 * through as bindings, and lifts the report out of stdout.
 *
 * Not a blocking CI gate (cost, non-determinism), per PRD-002 — but a
 * documented pre-merge step for any prompt or model change, and the baseline it
 * writes is committed.
 */

const prompt = env.EVAL_PROMPT ?? "default";
const only = env.EVAL_ONLY ? env.EVAL_ONLY.split(",").map((s) => s.trim()) : undefined;
const system = prompt === "default" ? undefined : PROMPTS[prompt];
if (prompt !== "default" && !system) {
  throw new Error(`unknown --prompt=${prompt}; known: default, ${Object.keys(PROMPTS).join(", ")}`);
}

describe("collections evals", () => {
  it(
    "runs the frozen scenario suite",
    async () => {
      const agent = collectionsEvalAgent(getLlmProvider(env));
      const report = await runEvals(agent, { system, prompt_label: prompt, only });

      // The table PRD-002 asks for, then the machine-readable block the wrapper
      // captures. console.log rather than a reporter so the output survives
      // whichever way the suite is invoked.
      console.log(formatReport(report));
      console.log(machineBlock(report));

      // Naming the failures is the point of the second acceptance criterion.
      expect(
        report.scenarios.filter((s) => s.status === "error").map((s) => s.id),
        "scenarios that threw",
      ).toEqual([]);
      expect(
        report.scenarios.filter((s) => s.status === "fail").map((s) => s.id),
        "scenarios that failed their expectation",
      ).toEqual([]);
    },
    // A live run makes one LLM call per scenario, sequentially: the default 5s
    // would time out long before the suite is the problem.
    600_000,
  );
});
