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

  /**
   * Platform-admin bearer secret guarding the internal provisioning API
   * (`/admin/*`, see src/gateway/routes/platform.ts) used to create new
   * companies. Production sets this via `wrangler secret put
   * PLATFORM_ADMIN_SECRET`; wrangler.jsonc carries a dev-only placeholder so
   * local dev and tests work out of the box. When unset, the /admin routes
   * refuse every request (fail closed).
   */
  PLATFORM_ADMIN_SECRET?: string;

  /**
   * Master key from which per-source webhook signing secrets are derived
   * (HMAC-SHA256(master, source_id) — see src/webhooks/verify.ts). Production
   * sets this via `wrangler secret put WEBHOOK_MASTER_SECRET`; wrangler.jsonc
   * carries a dev-only placeholder. When unset, /webhooks/* and webhook-source
   * provisioning refuse every request (fail closed).
   */
  WEBHOOK_MASTER_SECRET?: string;

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
