#!/usr/bin/env node
/**
 * `npm run eval` — the CLI in front of the eval harness.
 *
 * PRD-002 specifies the interface: `npm run eval` prints the table, and
 * `npm run eval -- --provider=openai --model=X` runs the comparison. The harness
 * itself lives in `evals/` and executes inside the Workers pool, so this script
 * does the three things a Worker cannot: parse argv, turn the flags into
 * bindings, and write the baseline file from what the run printed.
 *
 * Flags:
 *   --provider=anthropic|openai   pin the provider (default: first key found)
 *   --model=<id>                  override the provider's default model
 *   --prompt=broken               run a deliberately broken prompt
 *   --only=c01-...,c14-...        run a subset of scenarios
 *   --write-baseline[=<file>]     write the run's baseline into evals/baseline/
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_OPEN = "<<<EVAL_REPORT_JSON";
const REPORT_CLOSE = "EVAL_REPORT_JSON>>>";

const flags = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
  if (!match) {
    console.error(`unrecognised argument: ${arg}`);
    process.exit(2);
  }
  flags.set(match[1], match[2] ?? "");
}

const env = { ...process.env };
if (flags.has("provider")) env.LLM_PROVIDER = flags.get("provider");
if (flags.has("model")) env.LLM_MODEL = flags.get("model");
if (flags.has("prompt")) env.EVAL_PROMPT = flags.get("prompt");
if (flags.has("only")) env.EVAL_ONLY = flags.get("only");

const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
if (!hasKey) {
  console.log(
    "\nNo LLM key configured — running against the deterministic fallback.\n" +
      "That is a real run, not a skipped one: PRD-002 requires the harness to report\n" +
      "which scenarios the fallback handles. Set ANTHROPIC_API_KEY or OPENAI_API_KEY\n" +
      "to evaluate a model.\n",
  );
}

const result = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.eval.config.ts", "--reporter=basic"],
  { cwd: ROOT, env, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
);

const stdout = result.stdout ?? "";
process.stdout.write(stdout);

// Lift the machine-readable block out of the run's output. A Worker cannot
// write files, so this is how a baseline gets to disk.
const start = stdout.lastIndexOf(REPORT_OPEN);
const end = stdout.lastIndexOf(REPORT_CLOSE);
let baseline = null;
if (start !== -1 && end > start) {
  try {
    baseline = JSON.parse(stdout.slice(start + REPORT_OPEN.length, end).trim());
  } catch (err) {
    console.error(`could not parse the eval report block: ${err}`);
  }
}

if (flags.has("write-baseline")) {
  if (!baseline) {
    console.error("refusing to write a baseline: no report block in the run output");
    process.exit(1);
  }
  const name =
    flags.get("write-baseline") ||
    `${baseline.agent}-${baseline.mode === "live" ? (baseline.model ?? "model") : "fallback"}.json`;
  const path = join(ROOT, "evals", "baseline", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`\nbaseline written: evals/baseline/${name}`);
  console.log("Commit it, and note the prompt version it was captured under.");
}

process.exit(result.status ?? 1);
