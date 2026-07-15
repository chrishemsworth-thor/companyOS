import { Hono } from "hono";
import type { AuthedEnv } from "../middleware/auth";
import { departmentsForRole } from "../../departments/registry";

/**
 * Machine-readable org taxonomy. Exposes the department registry so agents
 * (and the console) can discover which departments exist, what modules each
 * surfaces, and its build status — the same lens the operator UI renders.
 *
 * Filtered by caller: a human (session actor carries a `role`) sees only the
 * departments their role may access; a programmatic/agent caller (tenant API
 * key → `system` actor, no role) sees the full list.
 */
export const meta = new Hono<AuthedEnv>();

meta.get("/departments", (c) => {
  const actor = c.get("user");
  // authenticate() always sets an actor before this route; only a human `user`
  // actor is role-scoped, everything else (system/agent) sees the full list.
  const role = actor?.type === "user" ? actor.role : undefined;
  return c.json({ departments: departmentsForRole(role) });
});
