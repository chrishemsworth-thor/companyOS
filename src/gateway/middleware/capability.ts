import { Hono, type Context, type MiddlewareHandler, type Next } from "hono";
import type { AuthedEnv } from "./auth";
import { can, type Action, type Capability, type CapabilityModule } from "../../auth/capabilities";

/**
 * Capability enforcement for `/v1` business routes.
 *
 * The design goal from PRD-008 is that "this route is unprotected" must be
 * impossible to miss. So gating is not per-route by default: every router is
 * mounted through `guardModule()` with a declared capability module, and the
 * action is derived from the HTTP method. A route added to an existing router
 * inherits its module's gate the moment it exists, and a *new* router cannot
 * reach `/v1` without appearing in the mount table (`src/index.ts`), where the
 * module argument is structurally required.
 *
 * Per-route `requireCapability()` is only used to *raise* the bar above the
 * module default — e.g. an admin-only surface inside an otherwise
 * operator-writable router.
 */

/** Methods that mutate state; everything else is a read. Mirrors session.ts. */
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** `write` for mutating methods, `read` for GET/HEAD/OPTIONS. */
export function actionForMethod(method: string): Action {
  return MUTATING.has(method) ? "write" : "read";
}

function forbidden(c: Context<AuthedEnv>, required: Capability) {
  return c.json({ error: `forbidden: requires ${required}`, code: "forbidden", required }, 403);
}

/**
 * Enforce one capability, whatever the method. Use to raise the bar on a single
 * route (admin-only actions inside a broader router).
 */
export function requireCapability(required: Capability): MiddlewareHandler<AuthedEnv> {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const user = c.get("user");
    // Programmatic callers (tenant API key → `system` actor) are trusted root
    // credentials for agents and bypass the matrix, as they always have.
    if (!user || user.type !== "user") return next();
    if (can(user.role, required)) return next();
    return forbidden(c, required);
  };
}

/**
 * Enforce a module's capability with the action derived from the request
 * method: reads need `<module>:read`, writes need `<module>:write`.
 */
export function requireModule(module: CapabilityModule): MiddlewareHandler<AuthedEnv> {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const user = c.get("user");
    if (!user || user.type !== "user") return next();
    const required = `${module}:${actionForMethod(c.req.method)}` as Capability;
    if (can(user.role, required)) return next();
    return forbidden(c, required);
  };
}

/**
 * Wrap a router so its module gate runs before any of its handlers.
 *
 * Hono composes middleware in registration order, and the route files register
 * their handlers at import time — so `router.use("*", …)` here would run *after*
 * the handler (too late to deny a write that already happened). Wrapping in a
 * fresh app whose middleware is registered first is what makes the gate a true
 * pre-check.
 */
export function guardModule(
  module: CapabilityModule,
  router: Hono<AuthedEnv>,
): Hono<AuthedEnv> {
  const guarded = new Hono<AuthedEnv>();
  guarded.use("*", requireModule(module));
  guarded.route("/", router);
  return guarded;
}
