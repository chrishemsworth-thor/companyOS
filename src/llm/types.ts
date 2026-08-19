/**
 * LLM port — provider-agnostic, mirroring the DeliveryProvider pattern.
 * Anthropic and OpenAI adapters implement it today; any provider that can
 * return schema-constrained JSON can be added without touching the agents.
 */

export interface StructuredRequest {
  /** System prompt: role, rules, tone. */
  system: string;
  /** The task prompt (context + instructions). */
  prompt: string;
  /** JSON Schema the response must conform to (draft the providers accept:
   *  object roots, enums, required, additionalProperties:false). */
  schema: Record<string, unknown>;
  /** Output token ceiling for the request. */
  max_tokens: number;
}

/** Tokens billed for one call, as the provider reported them. */
export interface StructuredUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * One structured completion: the parsed JSON, plus what it cost to get.
 *
 * The usage and the resolved model id are here rather than left at the provider
 * because PRD-002 requires token counts, model and cost on every decision, and
 * the provider boundary is the only place those facts exist. `model` is what the
 * API said it served — not what was requested — so an alias resolving to a
 * different snapshot is recorded honestly.
 */
export interface StructuredResult {
  output: unknown;
  model: string;
  /** Null when the provider returned no usage block. */
  usage: StructuredUsage | null;
}

export interface LlmProvider {
  readonly name: "anthropic" | "openai";
  /**
   * Ask for a JSON object conforming to `schema`. Returns the parsed JSON with
   * its usage; throws on API failure, refusal, or unparseable output. Callers
   * validate the result (Zod) and fall back — an LLM error must never stop the
   * agent.
   */
  completeStructured(req: StructuredRequest): Promise<StructuredResult>;
}
