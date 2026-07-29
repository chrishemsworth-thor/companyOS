import { Hono } from "hono";
import type { AuthedEnv } from "../middleware/auth";
import { getEmployeeByUserId } from "../../modules/people/service";

/**
 * Self-service surface, mounted at /v1/me against the `self` capability module.
 *
 * This is the *identity axis* of PRD-008: what you may see and do about
 * yourself, regardless of business capability. Every role holds `self`, so an
 * `employee` login — which is refused everywhere else under /v1 — has somewhere
 * useful to land, and PRD-006's leave balance and claims hang off here without
 * widening anyone's business access.
 *
 * Ownership is resolved from the session's user id, never from a path
 * parameter, so there is no id to tamper with: you can only ever read your own
 * record.
 */
export const me = new Hono<AuthedEnv>();

/** HR-authored fields an employee should not read about themselves. */
const SELF_HIDDEN = ["notes"] as const;

me.get("/employee", async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  // A tenant-API-key caller has no "self" to resolve. Agents read the People
  // module directly, so this is a client error rather than a 403.
  if (actor?.type !== "user" || !actor.id) {
    return c.json(
      { error: "self-service routes require a human session", code: "not_a_user" },
      400,
    );
  }

  const employee = await getEmployeeByUserId(c.env.DB, tenant.tenant_id, actor.id);
  // A login that isn't linked to an employee record (an external admin, say)
  // has no self record — not an error state, just nothing to show.
  if (!employee) {
    return c.json({ error: "no employee record linked to this login", code: "not_linked" }, 404);
  }

  // `notes` is HR's commentary *about* the person, not a field for them, so the
  // self view drops it. Everything else on the record is theirs to see.
  const view = { ...employee };
  for (const field of SELF_HIDDEN) delete (view as Record<string, unknown>)[field];
  return c.json({ employee: view });
});
