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

/**
 * `GET /v1/meta/users` — id → display name for the caller's tenant.
 *
 * A name directory, not user management. `/v1/users` is admin-only and returns
 * roles, status and invite state; PRD-007's approvals inbox needs something
 * different and much narrower — a manager who is not an admin still has to see
 * "requested by Aisha" on a card and "with Chen" on their own request, and
 * rendering a raw `usr_01J...` there would make the screen unusable.
 *
 * So this is deliberately the minimum that solves it: id, display name, email.
 * No role, no status, no credential state. Within one tenant, colleagues'
 * names are not privileged information — an org chart already exposes them
 * through /v1/people — and this leaks strictly less than that does.
 *
 * Tenant-scoped like everything under /v1, so it cannot enumerate another
 * company's staff.
 */
meta.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT user_id, display_name, email FROM users
     WHERE tenant_id = ? AND status = 'active'
     ORDER BY display_name, email`,
  )
    .bind(c.get("tenant").tenant_id)
    .all<{ user_id: string; display_name: string | null; email: string }>();
  return c.json({ users: results ?? [] });
});
