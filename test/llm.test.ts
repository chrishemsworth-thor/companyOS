import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { getLlmProvider } from "../src/llm";
import { AnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from "../src/llm/anthropic";
import { OpenAiLlm, DEFAULT_OPENAI_MODEL } from "../src/llm/openai";

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
    expect(result).toEqual({ ok: true });

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
        }),
        { status: 200 },
      ),
    );

    const result = await new OpenAiLlm("sk-oai-test").completeStructured(REQUEST);
    expect(result).toEqual({ ok: true });

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
