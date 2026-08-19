import { env } from "cloudflare:test";

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
