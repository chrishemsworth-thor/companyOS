import type { Env } from "../src/env";

/**
 * The eval harness's extra bindings. `scripts/run-evals.mjs` turns the CLI
 * flags into these, because a Worker cannot read `process.env` and the harness
 * runs inside workerd on purpose.
 */
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    /** Which system prompt to run: "default", or a key from evals/prompts. */
    EVAL_PROMPT?: string;
    /** Comma-separated scenario ids, to run a subset. */
    EVAL_ONLY?: string;
  }
}
