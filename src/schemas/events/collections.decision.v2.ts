import { z } from "zod";

/**
 * collections.decision.v2 — the full audit record of every CollectionsAgent
 * decision (PRD-002 P0 decision observability).
 *
 * **Why a v2 file and a registry bump rather than an edit.** PRD-002 extends the
 * payload with provider, model, prompt version, token counts, latency, cost,
 * whether the fallback ran and whether a guardrail overrode the decision. Those
 * are required fields, so a consumer written against v1 cannot read a v2 event
 * as complete and a producer written against v1 cannot emit one — that is a
 * breaking payload change, and the convention documented in `registry.ts` says
 * add a file and bump the mapping. Events already in `events_log` were validated
 * when they were written and are never re-validated, so v1 history stays
 * readable; the console reads both by treating the new fields as optional in its
 * own view types.
 *
 * S8's `contact_id` / `contact_match` are carried forward as the SESSION-PLAN
 * event table requires — they arrived as optional additions to a non-strict v1
 * and are first-class here.
 */
export const collectionsDecisionV2 = z.object({
  customer_id: z.string(),

  // ---- the decision itself (v1) ----
  risk_score: z.number().int().min(0).max(100),
  action: z.enum(["remind", "escalate", "wait"]),
  channel: z.enum(["email", "whatsapp"]),
  message: z.string(),
  /**
   * `llm` or `fallback` — this IS PRD-002's "whether fallback was used". A
   * separate boolean would be the same fact under two names, and the console
   * and the insights query already read this one.
   */
  source: z.enum(["llm", "fallback"]),
  trigger: z.enum(["event", "alarm"]),

  /**
   * The invoice the decision was about. New in v2 and load-bearing for later:
   * PRD-002's P2 outcome scoring ("did the invoice get paid within N days of the
   * agent's action?") is a query over this column rather than a migration,
   * which is exactly what the PRD asks v1 to design for. Null only when nothing
   * was actually due.
   */
  invoice_id: z.string().nullable(),

  // ---- who the decision targeted (S8, PRD-003) ----
  contact_id: z.string().nullable(),
  contact_match: z.enum(["role", "primary", "any"]).nullable(),

  // ---- how it was reached (PRD-002) ----
  /** Null when no provider was configured and the fallback ran. */
  provider: z.enum(["anthropic", "openai"]).nullable(),
  /** The model the API reported serving — not the one requested. */
  model: z.string().nullable(),
  /** See PROMPT_VERSION in src/agents/decision.ts; an eval baseline is tied to it. */
  prompt_version: z.string(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  latency_ms: z.number().int().min(0),
  /**
   * Estimated cost in integer micro-USD (1e-6 USD). Null when the model has no
   * known rate — a guessed cost would quietly corrupt the per-tenant spend
   * figure this field exists to produce.
   */
  cost_micros: z.number().int().nullable(),
  /** Present when the fallback ran: no provider, an API error, or bad output. */
  fallback_reason: z.string().nullable(),

  // ---- what the guardrails did (PRD-002) ----
  /**
   * Whether a guardrail changed this decision. Denormalized alongside
   * `overrides` so the override-rate metric is one `json_extract` rather than a
   * JSON array length, and PRD-002 holds that rate to < 10% on the eval suite.
   */
  guardrail_overridden: z.boolean(),
  /** Which rules fired, in order. Each also emitted `guardrail.override.v1`. */
  overrides: z.array(z.string()),
  /** Set when the send was deferred out of the tenant's contact window. */
  deferred_until: z.string().nullable(),
});
export type CollectionsDecisionV2 = z.infer<typeof collectionsDecisionV2>;
