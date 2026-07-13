/**
 * Worker environment bindings, matching wrangler.jsonc.
 */
export interface Env {
  DB: D1Database;
  CONFIG_CACHE: KVNamespace;
  /** Hot lookup store for human operator sessions (see src/auth/session.ts). */
  SESSIONS: KVNamespace;
  EVENTS: Queue;
  COLLECTIONS_AGENT: DurableObjectNamespace;

  /**
   * HMAC signing secret for session cookies. Production sets this via
   * `wrangler secret put SESSION_SECRET`; wrangler.jsonc carries a dev-only
   * placeholder so local dev and tests work out of the box.
   */
  SESSION_SECRET: string;
  /** Comma-separated browser origins allowed to send credentialed requests. */
  ALLOWED_ORIGINS?: string;

  // Optional delivery-provider secrets (`wrangler secret put ...`). When a
  // secret is absent the channel falls back to ConsoleDelivery — the test
  // suite never configures them, so tests always hit the console provider.
  RESEND_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;

  // Optional LLM configuration for the smart CollectionsAgent. The LLM port
  // (src/llm/) is provider-agnostic: set the API key for the provider you
  // use. Without any key the agent runs its deterministic fallback.
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Pin a provider explicitly ("anthropic" | "openai"); default: first configured key. */
  LLM_PROVIDER?: string;
  /** Override the provider's default model id. */
  LLM_MODEL?: string;
}
