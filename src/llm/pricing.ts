/**
 * Cost estimation for a decision (PRD-002 P0 observability: "cost estimate" on
 * every decision, and "per-tenant LLM spend visible so that pricing can cover
 * cost").
 *
 * Money is counted in **integer micro-USD** (1e-6 USD). Per-token prices are
 * far below a cent, so a float would accumulate rounding across a month of
 * decisions, and this number is destined for a pricing conversation.
 *
 * An unknown model estimates `null`, never a guess. A wrong cost on an invoice
 * conversation is worse than an absent one, and the honest answer — "we do not
 * have a rate for this model" — is actionable: set `LLM_PRICE_INPUT_PER_MTOK`
 * and `LLM_PRICE_OUTPUT_PER_MTOK`.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  input_per_mtok: number;
  /** USD per million output tokens. */
  output_per_mtok: number;
}

/**
 * Anthropic first-party API rates, current as of 2026-06. Standard rates only:
 * introductory and promotional pricing is deliberately not encoded, because it
 * expires and a stale discount understates spend.
 *
 * Deliberately keyed on the exact model id the provider reports back, not on a
 * prefix. A model id we have never seen priced should read as unknown rather
 * than inherit a neighbour's rate.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-opus-4-8": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-opus-4-7": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-opus-4-6": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-sonnet-5": { input_per_mtok: 3, output_per_mtok: 15 },
  "claude-sonnet-4-6": { input_per_mtok: 3, output_per_mtok: 15 },
  "claude-haiku-4-5": { input_per_mtok: 1, output_per_mtok: 5 },
  "claude-fable-5": { input_per_mtok: 10, output_per_mtok: 50 },
  // OpenAI models are absent on purpose. Their rates are not encoded here
  // because nobody has checked them against the current price list, and the
  // env override below is how an operator supplies one for a comparison run
  // without a deploy.
};

export interface PriceOverride {
  LLM_PRICE_INPUT_PER_MTOK?: string;
  LLM_PRICE_OUTPUT_PER_MTOK?: string;
}

export function priceFor(model: string, env?: PriceOverride): ModelPrice | null {
  const input = Number(env?.LLM_PRICE_INPUT_PER_MTOK);
  const output = Number(env?.LLM_PRICE_OUTPUT_PER_MTOK);
  // Both or neither: half an override is a misconfiguration, not a rate.
  if (Number.isFinite(input) && Number.isFinite(output) && env?.LLM_PRICE_INPUT_PER_MTOK) {
    return { input_per_mtok: input, output_per_mtok: output };
  }
  return MODEL_PRICES[model] ?? null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Micro-USD for one call, rounded to the nearest micro-dollar. Null when the
 * model has no known rate. */
export function estimateCostMicros(
  model: string,
  usage: TokenUsage | null,
  env?: PriceOverride,
): number | null {
  if (!usage) return null;
  const price = priceFor(model, env);
  if (!price) return null;
  const dollars =
    (usage.input_tokens / 1_000_000) * price.input_per_mtok +
    (usage.output_tokens / 1_000_000) * price.output_per_mtok;
  return Math.round(dollars * 1_000_000);
}

/** Micro-USD → a display string, for a report or a console tile. */
export function formatMicros(micros: number | null): string {
  if (micros === null) return "—";
  return `$${(micros / 1_000_000).toFixed(6)}`;
}
