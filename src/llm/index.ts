import type { Env } from "../env";
import type { LlmProvider } from "./types";
import { AnthropicLlm } from "./anthropic";
import { OpenAiLlm } from "./openai";

export type { LlmProvider, StructuredRequest } from "./types";

type LlmFactory = (env: Env) => LlmProvider | null;

/**
 * Test seam (same pattern as the delivery port's console fallback): tests
 * inject a stub provider so the suite never touches a live LLM API.
 */
let overrideFactory: LlmFactory | null = null;

export function setLlmProviderFactoryForTests(factory: LlmFactory | null): void {
  overrideFactory = factory;
}

/**
 * Provider selection point. `LLM_PROVIDER` pins a provider explicitly;
 * otherwise the first configured API key wins (Anthropic, then OpenAI).
 * No key → null, and callers use their non-LLM fallback path — the test
 * suite never configures keys, so tests always exercise the fallback
 * unless they inject a stub.
 */
export function getLlmProvider(env: Env): LlmProvider | null {
  if (overrideFactory) return overrideFactory(env);

  switch (env.LLM_PROVIDER) {
    case "anthropic":
      return env.ANTHROPIC_API_KEY ? new AnthropicLlm(env.ANTHROPIC_API_KEY, env.LLM_MODEL) : null;
    case "openai":
      return env.OPENAI_API_KEY ? new OpenAiLlm(env.OPENAI_API_KEY, env.LLM_MODEL) : null;
    case undefined:
      break;
    default:
      console.warn(`[llm] unknown LLM_PROVIDER "${env.LLM_PROVIDER}", falling back to key detection`);
  }

  if (env.ANTHROPIC_API_KEY) return new AnthropicLlm(env.ANTHROPIC_API_KEY, env.LLM_MODEL);
  if (env.OPENAI_API_KEY) return new OpenAiLlm(env.OPENAI_API_KEY, env.LLM_MODEL);
  return null;
}
