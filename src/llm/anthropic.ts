import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, StructuredRequest, StructuredResult } from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

/**
 * Claude via the official SDK (fetch-based, runs natively on Workers).
 * Adaptive thinking + structured outputs; no sampling params (removed on
 * this model family).
 */
export class AnthropicLlm implements LlmProvider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string = DEFAULT_ANTHROPIC_MODEL,
  ) {
    this.client = new Anthropic({
      apiKey,
      // Resolve the global fetch per call rather than at construction, so
      // the DO can build the client once and tests can stub fetch freely.
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    });
  }

  async completeStructured(req: StructuredRequest): Promise<StructuredResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.max_tokens,
      system: req.system,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: req.schema } },
      messages: [{ role: "user", content: req.prompt }],
    });
    if (response.stop_reason === "refusal") {
      throw new Error("anthropic: request refused");
    }
    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") {
      throw new Error(`anthropic: no text block in response (stop: ${response.stop_reason})`);
    }
    return {
      output: JSON.parse(text.text),
      // What the API served, which is not always what was asked for.
      model: response.model ?? this.model,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }
}
