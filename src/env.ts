/**
 * Worker environment bindings, matching wrangler.jsonc.
 */
export interface Env {
  DB: D1Database;
  CONFIG_CACHE: KVNamespace;
  EVENTS: Queue;
  COLLECTIONS_AGENT: DurableObjectNamespace;
}
