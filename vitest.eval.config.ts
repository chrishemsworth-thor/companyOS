import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * `npm run eval`'s config, separate from `vitest.config.ts` so the evals never
 * run as part of `npm test`. PRD-002 is explicit that the eval run is not a
 * blocking gate — it costs money and it is non-deterministic — while the tests
 * are both free and deterministic. Mixing them would make one of those untrue.
 *
 * The harness's own behaviour (its checks, its reporting, its baseline) IS
 * tested, deterministically, in `test/evals-harness.test.ts`.
 */

/** Passed through from the shell so a comparison run needs no code change. */
const PASSTHROUGH = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LLM_PRICE_INPUT_PER_MTOK",
  "LLM_PRICE_OUTPUT_PER_MTOK",
  "EVAL_PROMPT",
  "EVAL_ONLY",
];

export default defineWorkersConfig(() => ({
  test: {
    include: ["evals/**/*.eval.ts"],
    // No setupFiles: the eval harness touches no D1. Its scenarios are frozen
    // fixtures precisely so a baseline compares like with like.
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: Object.fromEntries(
            PASSTHROUGH.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
          ),
        },
      },
    },
  },
}));
