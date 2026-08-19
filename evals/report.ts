import { formatMicros } from "../src/llm/pricing";
import type { RunReport, ScenarioResult } from "./types";

/**
 * `npm run eval`'s output: the table PRD-002 asks for — "scenario, expected,
 * actual, pass/fail, tokens, latency, cost" — plus the totals its fourth
 * acceptance criterion wants, and a machine-readable block the wrapper script
 * captures to write a baseline.
 */

const MARK: Record<ScenarioResult["status"], string> = {
  pass: "PASS",
  fail: "FAIL",
  gap: "GAP ",
  error: "ERR ",
};

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

export function formatReport(report: RunReport): string {
  const lines: string[] = [];
  const { totals } = report;

  lines.push("");
  lines.push(
    `${report.agent} evals — ${report.mode === "live" ? `${report.provider} ${report.model}` : "deterministic fallback (no LLM configured)"}`,
  );
  lines.push(`prompt ${report.prompt_version} (${report.prompt_label})`);
  lines.push("");
  lines.push(
    `${pad("scenario", 34)}${pad("expected", 30)}${pad("actual", 34)}${pad("", 6)}${pad("tok in/out", 13)}${pad("ms", 7)}cost`,
  );
  lines.push("-".repeat(140));

  for (const r of report.scenarios) {
    const o = r.observation;
    lines.push(
      pad(r.id, 34) +
        pad(r.expected, 30) +
        pad(r.actual, 34) +
        pad(MARK[r.status], 6) +
        pad(o ? `${o.input_tokens ?? "—"}/${o.output_tokens ?? "—"}` : "—", 13) +
        pad(o ? String(o.latency_ms) : "—", 7) +
        (o ? formatMicros(o.cost_micros) : "—"),
    );
  }

  lines.push("-".repeat(140));
  lines.push(
    `${totals.passed}/${totals.scenarios} passed · ${totals.failed} failed · ${totals.gaps} fallback gaps · ${totals.errors} errors`,
  );
  lines.push(
    `tokens ${totals.input_tokens} in / ${totals.output_tokens} out · total cost ${formatMicros(totals.cost_micros)} · p95 latency ${totals.p95_latency_ms}ms (max ${totals.max_latency_ms}ms)`,
  );

  const failures = report.scenarios.filter((r) => r.status === "fail" || r.status === "error");
  if (failures.length > 0) {
    lines.push("");
    // Naming the scenarios is PRD-002's second eval criterion: a broken prompt
    // has to say WHICH scenarios it broke, or the suite is just a red light.
    lines.push(`FAILED: ${failures.map((f) => f.id).join(", ")}`);
    for (const f of failures) {
      lines.push("");
      lines.push(`  ${f.id} — ${f.title}`);
      lines.push(`    covers: ${f.covers}`);
      if (f.error) lines.push(`    threw: ${f.error}`);
      for (const c of f.checks.filter((c) => !c.ok)) lines.push(`    ✗ ${c.name}: ${c.detail}`);
      if (f.observation) lines.push(`    message: ${JSON.stringify(f.observation.message)}`);
    }
  }

  const gaps = report.scenarios.filter((r) => r.status === "gap");
  if (gaps.length > 0) {
    lines.push("");
    // PRD-002's third eval criterion: report which scenarios the fallback
    // handles. These are the ones it does not, declared in the fixture.
    lines.push(`Fallback gaps (declared, not failures):`);
    for (const g of gaps) lines.push(`  ${g.id} — ${g.gap_note ?? "no note"}`);
  }

  const fixtureOnly = report.scenarios.filter((r) => r.fixture_only);
  if (fixtureOnly.length > 0) {
    lines.push("");
    lines.push(`Fixture-only contexts (the live agent cannot assemble these yet):`);
    for (const f of fixtureOnly) {
      lines.push(`  ${f.id} — blocked by ${f.fixture_only!.blocked_by}: ${f.fixture_only!.note}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * The committed-baseline shape. Deliberately excludes latency, tokens and cost:
 * a baseline is for catching a behaviour change, and pinning a millisecond count
 * would make it fail on a slow morning.
 */
export interface Baseline {
  agent: string;
  mode: "live" | "fallback";
  prompt_version: string;
  model: string | null;
  scenarios: { id: string; status: string; action: string | null; source: string | null }[];
  totals: { scenarios: number; passed: number; failed: number; gaps: number; errors: number };
}

export function toBaseline(report: RunReport): Baseline {
  return {
    agent: report.agent,
    mode: report.mode,
    prompt_version: report.prompt_version,
    model: report.model,
    scenarios: report.scenarios.map((r) => ({
      id: r.id,
      status: r.status,
      action: r.observation?.action ?? null,
      source: r.observation?.source ?? null,
    })),
    totals: {
      scenarios: report.totals.scenarios,
      passed: report.totals.passed,
      failed: report.totals.failed,
      gaps: report.totals.gaps,
      errors: report.totals.errors,
    },
  };
}

/** Fenced so `scripts/run-evals.mjs` can lift the baseline out of stdout — a
 * Worker cannot write files, and the harness runs inside workerd on purpose. */
export const REPORT_OPEN = "<<<EVAL_REPORT_JSON";
export const REPORT_CLOSE = "EVAL_REPORT_JSON>>>";

export function machineBlock(report: RunReport): string {
  return [REPORT_OPEN, JSON.stringify(toBaseline(report)), REPORT_CLOSE].join("\n");
}
