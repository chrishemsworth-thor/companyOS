/**
 * Worker environment bindings, matching wrangler.jsonc.
 */
export interface Env {
  DB: D1Database;
  CONFIG_CACHE: KVNamespace;
  EVENTS: Queue;
  COLLECTIONS_AGENT: DurableObjectNamespace;

  // Optional delivery-provider secrets (`wrangler secret put ...`). When a
  // secret is absent the channel falls back to ConsoleDelivery — the test
  // suite never configures them, so tests always hit the console provider.
  RESEND_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
}
