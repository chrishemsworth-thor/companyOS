import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { getLlmProvider } from "../src/llm";
import { AnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from "../src/llm/anthropic";
import { OpenAiLlm, DEFAULT_OPENAI_MODEL } from "../src/llm/openai";
import { estimateCostMicros, formatMicros } from "../src/llm/pricing";

/**
 * The provider-agnostic LLM port. Request shapes are asserted against a
 * stubbed global fetch — the suite never talks to a live LLM API.
 */

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

const REQUEST = {
  system: "You are a test.",
  prompt: "Return ok.",
  schema: SCHEMA,
  max_tokens: 1024,
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.LLM_PROVIDER;
  delete env.LLM_MODEL;
});

function stubFetch(response: Response) {
  const mock = vi.fn(async () => response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function anthropicResponse(text: string, stopReason = "end_turn"): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: DEFAULT_ANTHROPIC_MODEL,
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("provider selection", () => {
  it("no keys configured → null (agent uses its fallback)", () => {
    expect(getLlmProvider(env)).toBeNull();
  });

  it("ANTHROPIC_API_KEY → Anthropic; OPENAI_API_KEY → OpenAI", () => {
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(getLlmProvider(env)?.name).toBe("anthropic");
    delete env.ANTHROPIC_API_KEY;
    env.OPENAI_API_KEY = "sk-oai-test";
    expect(getLlmProvider(env)?.name).toBe("openai");
  });

  it("LLM_PROVIDER pins the provider when both keys exist", () => {
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    env.OPENAI_API_KEY = "sk-oai-test";
    env.LLM_PROVIDER = "openai";
    expect(getLlmProvider(env)?.name).toBe("openai");
    env.LLM_PROVIDER = "anthropic";
    expect(getLlmProvider(env)?.name).toBe("anthropic");
  });
});

describe("anthropic adapter", () => {
  it("sends adaptive thinking + json_schema output_config to /v1/messages", async () => {
    const mock = stubFetch(anthropicResponse(JSON.stringify({ ok: true })));

    const result = await new AnthropicLlm("sk-ant-test").completeStructured(REQUEST);
    // The port carries usage and the served model id alongside the JSON:
    // PRD-002 records token counts and cost on every decision, and the provider
    // boundary is the only place those exist.
    expect(result).toEqual({
      output: { ok: true },
      model: DEFAULT_ANTHROPIC_MODEL,
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("x-api-key")).toBe("sk-ant-test");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema: SCHEMA } });
    expect(body.system).toBe(REQUEST.system);
    expect(body.messages).toEqual([{ role: "user", content: REQUEST.prompt }]);
    expect(body.temperature).toBeUndefined();
  });

  it("throws on a refusal stop_reason", async () => {
    stubFetch(anthropicResponse("", "refusal"));
    await expect(new AnthropicLlm("sk-ant-test").completeStructured(REQUEST)).rejects.toThrow(
      /refused/,
    );
  });
});

describe("openai adapter", () => {
  it("sends strict json_schema response_format to chat/completions", async () => {
    const mock = stubFetch(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" },
          ],
          model: DEFAULT_OPENAI_MODEL,
          usage: { prompt_tokens: 40, completion_tokens: 12 },
        }),
        { status: 200 },
      ),
    );

    const result = await new OpenAiLlm("sk-oai-test").completeStructured(REQUEST);
    // OpenAI names its usage fields differently; the port normalizes them.
    expect(result).toEqual({
      output: { ok: true },
      model: DEFAULT_OPENAI_MODEL,
      usage: { input_tokens: 40, output_tokens: 12 },
    });

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer sk-oai-test");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "decision", strict: true, schema: SCHEMA },
    });
    expect(body.messages).toEqual([
      { role: "system", content: REQUEST.system },
      { role: "user", content: REQUEST.prompt },
    ]);
  });

  it("throws on HTTP failure and on refusal", async () => {
    stubFetch(new Response("nope", { status: 500 }));
    await expect(new OpenAiLlm("sk-oai-test").completeStructured(REQUEST)).rejects.toThrow(/500/);

    stubFetch(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      ),
    );
    await expect(new OpenAiLlm("sk-oai-test").completeStructured(REQUEST)).rejects.toThrow(
      /refused/,
    );
  });

  it("LLM_MODEL overrides the default model id", async () => {
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    env.LLM_MODEL = "claude-sonnet-5";
    const provider = getLlmProvider(env)!;
    const mock = stubFetch(anthropicResponse(JSON.stringify({ ok: true })));
    await provider.completeStructured(REQUEST);
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { model: string }).model).toBe("claude-sonnet-5");
  });
});

describe("usage and cost", () => {
  it("reports no usage when the provider returns none", async () => {
    // A provider that omits its usage block must yield a null cost, not a zero
    // one: "we do not know" and "it was free" are different facts.
    stubFetch(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }],
        }),
        { status: 200 },
      ),
    );
    const result = await new OpenAiLlm("sk-oai-test").completeStructured(REQUEST);
    expect(result.usage).toBeNull();
    expect(estimateCostMicros(result.model, result.usage)).toBeNull();
  });

  it("prices a known model in integer micro-USD", () => {
    // Claude Opus 4.8: $5/1M input, $25/1M output.
    expect(
      estimateCostMicros("claude-opus-4-8", { input_tokens: 1_000_000, output_tokens: 0 }),
    ).toBe(5_000_000);
    expect(
      estimateCostMicros("claude-opus-4-8", { input_tokens: 0, output_tokens: 1_000_000 }),
    ).toBe(25_000_000);
    // A realistic decision: ~1.2k in, ~180 out.
    expect(estimateCostMicros("claude-opus-4-8", { input_tokens: 1_200, output_tokens: 180 })).toBe(
      10_500,
    );
  });

  it("estimates nothing for a model it has no rate for", () => {
    // A wrong cost on an invoice conversation is worse than an absent one.
    expect(estimateCostMicros("some-local-llama", { input_tokens: 100, output_tokens: 100 })).toBeNull();
  });

  it("uses the operator's rates for an unpriced model, both or neither", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(
      estimateCostMicros("some-local-llama", usage, {
        LLM_PRICE_INPUT_PER_MTOK: "0.5",
        LLM_PRICE_OUTPUT_PER_MTOK: "1.5",
      }),
    ).toBe(2_000_000);
    // Half an override is a misconfiguration, not a rate.
    expect(
      estimateCostMicros("some-local-llama", usage, { LLM_PRICE_INPUT_PER_MTOK: "0.5" }),
    ).toBeNull();
  });

  it("formats micro-USD for display, and says nothing when it knows nothing", () => {
    expect(formatMicros(10_500)).toBe("$0.010500");
    expect(formatMicros(null)).toBe("—");
  });
});
