import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who caused a write. Threaded through the request via AsyncLocalStorage so
 * event emission can attribute an actor without every service signature
 * growing an `actor` parameter.
 *
 * - `user`   — a human operator acting through the session-authenticated UI.
 * - `agent`  — an autonomous agent (e.g. the CollectionsAgent).
 * - `system` — cron/queue/bootstrap or a programmatic tenant-API-key caller.
 *
 * Requires the `nodejs_als` compatibility flag (set in wrangler.jsonc). When no
 * store is active (queue consumer, cron) `currentActor()` returns undefined and
 * attribution falls back to NULL — see migration 0011.
 */
export interface Actor {
  type: "user" | "agent" | "system";
  /** usr_<ulid> for users; agent name for agents; undefined for system. */
  id?: string;
  /** Present for user actors — their role at the time of the action. */
  role?: string;
}

const actorStore = new AsyncLocalStorage<Actor>();

/** Run `fn` with `actor` as the ambient actor for its entire async subtree. */
export function runWithActor<T>(actor: Actor | undefined, fn: () => T): T {
  if (!actor) return fn();
  return actorStore.run(actor, fn);
}

/** The actor for the current async context, or undefined outside a request. */
export function currentActor(): Actor | undefined {
  return actorStore.getStore();
}
