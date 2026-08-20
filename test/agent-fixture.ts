import { env } from "cloudflare:test";
import { setLlmProviderFactoryForTests } from "../src/llm";
import type { StructuredResult } from "../src/llm/types";

/**
 * Shared agent-guardrail fixtures (PRD-002, S10).
 *
 * Every suite that drives the CollectionsAgent now runs through the shared
 * guard, and the guard asks what time it is where the tenant is. A suite about
 * decisions, contact roles or delivery must not start failing because CI ran at
 * 02:00 Kuala Lumpur time — so those suites open the window explicitly and say
 * so, rather than depending on the wall clock.
 *
 * The window itself is tested where it belongs: `agent-guardrails-window.test.ts`
 * (pure, fixed timestamps) and `agent-guardrails.test.ts` (through the DO).
 *
 * **Before adding a test that drives the agent, read
 * [`docs/testing/durable-object-suites.md`](../docs/testing/durable-object-suites.md).**
 * Two things there will otherwise cost you an afternoon: a frozen clock pinned
 * near today makes Durable Object alarms fire immediately (miniflare schedules
 * on the real clock while `Date.now()` is faked), and reading DO storage from the
 * test realm breaks the pool's isolated-storage snapshots.
 */

/**
 * A policy that permits contact at any hour, on any day. Only the window and
 * day suppression are relaxed — the cooldown, the reminder cap and the
 * escalation gate keep their defaults, because suites depend on those.
 */
export async function openContactWindow(tenantId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_settings
       (tenant_id, contact_window_start_hour, contact_window_end_hour,
        suppress_weekends, suppress_holidays)
     VALUES (?, 0, 24, 0, 0)
     ON CONFLICT (tenant_id) DO UPDATE SET
       contact_window_start_hour = 0, contact_window_end_hour = 24,
       suppress_weekends = 0, suppress_holidays = 0`,
  )
    .bind(tenantId)
    .run();
}


/**
 * Wrap a decision in the shape the LLM port returns.
 *
 * The port carries token counts and the served model id alongside the parsed
 * JSON, because PRD-002 requires both on every decision and the provider
 * boundary is the only place they exist. Tests still mock the *decision*; this
 * puts the envelope around it.
 */
export function llmResult(
  output: unknown,
  over: Partial<StructuredResult> = {},
): StructuredResult {
  return {
    output,
    model: "claude-opus-4-8",
    usage: { input_tokens: 1_200, output_tokens: 180 },
    ...over,
  };
}

/**
 * Install a stub provider whose `completeStructured` resolves whatever `mock`
 * resolves, wrapped by `llmResult`. A rejecting mock still rejects, so the
 * fallback path stays testable.
 */
export function stubLlmProvider(
  mock: (req: unknown) => Promise<unknown>,
  over: Partial<StructuredResult> = {},
): void {
  setLlmProviderFactoryForTests(() => ({
    name: "anthropic",
    completeStructured: async (req) => llmResult(await mock(req), over),
  }));
}
