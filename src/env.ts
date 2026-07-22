/**
 * Worker environment bindings, matching wrangler.jsonc.
 */
export interface Env {
  DB: D1Database;
  CONFIG_CACHE: KVNamespace;
  /** Hot lookup store for human operator sessions (see src/auth/session.ts). */
  SESSIONS: KVNamespace;
  /**
   * Event-bus producer. On the paid plan this is the Cloudflare Queues
   * binding (wrangler.jsonc); on a free-plan deploy (wrangler.free.jsonc) the
   * binding is absent at runtime and every entry point substitutes the
   * inline direct bus via ensureEventBus() before anything reads it — see
   * src/queue/direct.ts and docs/queue-send.md.
   */
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

  // Google (Gmail/Workspace) email integration. All three are required to
  // connect or use an account; when any is absent the /v1/google-accounts and
  // /oauth/google routes fail closed (503). Production sets these via `wrangler
  // secret put ...`; wrangler.jsonc carries dev-only placeholders.
  //   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET: the OAuth 2.0 web client.
  //   - GOOGLE_TOKEN_ENCRYPTION_KEY: base64 of 32 random bytes, the AES-256-GCM
  //     key that encrypts stored refresh tokens (src/integrations/google/crypto.ts).
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_TOKEN_ENCRYPTION_KEY?: string;
  /**
   * Optional explicit OAuth redirect URI. When unset it is derived from the
   * request origin as `${origin}/oauth/google/callback`. Set this when the
   * public origin differs from what the Worker sees (e.g. behind a custom
   * domain) — it must match a redirect URI registered on the OAuth client.
   */
  GOOGLE_OAUTH_REDIRECT_URI?: string;

  // Optional LLM configuration for the smart CollectionsAgent. The LLM port
  // (src/llm/) is provider-agnostic: set the API key for the provider you
  // use. Without any key the agent runs its deterministic fallback.
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Pin a provider explicitly ("anthropic" | "openai"); default: first configured key. */
  LLM_PROVIDER?: string;
  /** Override the provider's default model id. */
  LLM_MODEL?: string;

  /**
   * Lead-enrichment provider selection (src/enrichment/). Absent or "noop"
   * means the built-in no-op provider; real data providers register their
   * names here as they land.
   */
  ENRICHMENT_PROVIDER?: string;
}
