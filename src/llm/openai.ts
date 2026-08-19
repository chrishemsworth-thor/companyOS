import type { LlmProvider, StructuredRequest, StructuredResult } from "./types";

export const DEFAULT_OPENAI_MODEL = "gpt-5";

interface ChatCompletionResponse {
  choices: {
    message: { content: string | null; refusal?: string | null };
    finish_reason: string;
  }[];
  model?: string;
  /** OpenAI names these differently from Anthropic; normalized on the way out. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI Chat Completions with structured outputs (`response_format:
 * json_schema, strict`). Plain fetch — no SDK dependency needed for this
 * surface, and it runs natively on Workers.
 */
export class OpenAiLlm implements LlmProvider {
  readonly name = "openai" as const;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_OPENAI_MODEL,
  ) {}

  async completeStructured(req: StructuredRequest): Promise<StructuredResult> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: req.max_tokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "decision", strict: true, schema: req.schema },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`openai request failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as ChatCompletionResponse;
    const choice = body.choices[0];
    if (!choice) throw new Error("openai: empty choices");
    if (choice.message.refusal) throw new Error(`openai: refused: ${choice.message.refusal}`);
    if (choice.message.content == null) {
      throw new Error(`openai: no content (finish: ${choice.finish_reason})`);
    }
    const usage =
      body.usage?.prompt_tokens === undefined || body.usage?.completion_tokens === undefined
        ? null
        : {
            input_tokens: body.usage.prompt_tokens,
            output_tokens: body.usage.completion_tokens,
          };
    return { output: JSON.parse(choice.message.content), model: body.model ?? this.model, usage };
  }
}
