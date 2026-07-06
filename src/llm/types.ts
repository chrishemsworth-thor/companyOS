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

export interface LlmProvider {
  readonly name: "anthropic" | "openai";
  /**
   * Ask for a JSON object conforming to `schema`. Returns the parsed JSON;
   * throws on API failure, refusal, or unparseable output. Callers validate
   * the result (Zod) and fall back — an LLM error must never stop the agent.
   */
  completeStructured(req: StructuredRequest): Promise<unknown>;
}
