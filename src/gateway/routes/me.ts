import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { getEmployeeByUserId } from "../../modules/people/service";
import { effectiveHolidays, getLeaveProfile, listLeaveTypes } from "../../modules/leave/service";
import { getBalances } from "../../modules/leave/balances";
import { holidayList } from "../../modules/leave/holidays/resolve";
import { leaveErrorResponse, workingDaysFor } from "./leave";
import type { Employee } from "../../modules/people/types";

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

/**
 * Resolve the caller's own employee record, or the response explaining why
 * there isn't one. Every self-service route starts here, so the ownership rule
 * — resolved from the session, never from a parameter — is written once.
 */
async function resolveSelf(
  c: Context<AuthedEnv>,
): Promise<{ employee: Employee } | { response: Response }> {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  // A tenant-API-key caller has no "self" to resolve. Agents read the People
  // module directly, so this is a client error rather than a 403.
  if (actor?.type !== "user" || !actor.id) {
    return {
      response: c.json(
        { error: "self-service routes require a human session", code: "not_a_user" },
        400,
      ),
    };
  }
  const employee = await getEmployeeByUserId(c.env.DB, tenant.tenant_id, actor.id);
  // A login that isn't linked to an employee record (an external admin, say)
  // has no self record — not an error state, just nothing to show.
  if (!employee) {
    return {
      response: c.json(
        { error: "no employee record linked to this login", code: "not_linked" },
        404,
      ),
    };
  }
  return { employee };
}

me.get("/employee", async (c) => {
  const self = await resolveSelf(c);
  if ("response" in self) return self.response;

  // `notes` is HR's commentary *about* the person, not a field for them, so the
  // self view drops it. Everything else on the record is theirs to see.
  const view = { ...self.employee };
  for (const field of SELF_HIDDEN) delete (view as Record<string, unknown>)[field];
  return c.json({ employee: view });
});

/**
 * Leave self-service (PRD-006b).
 *
 * These sit on the `self` capability module, so the `employee` tier — refused
 * everywhere else under /v1, including the People directory — can see its own
 * balance and its own holidays without any business access at all. That is the
 * whole point of the identity axis in PRD-008.
 *
 * Every route resolves the employee from the session, so there is no id to
 * tamper with and no way to read somebody else's balance. HR reads other
 * people's numbers through /v1/people/leave, which is gated on `people:read`.
 *
 * S6 ships no leave *request* route: submission, approval and cancellation are
 * S7. What is here is what an employee needs to decide whether to ask —
 * balance, holidays, and the working-day cost of a date range.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO_DATE, "must be YYYY-MM-DD");

// See the note in routes/leave.ts: z.coerce.boolean() would read "false" as true.
const queryFlag = z
  .string()
  .optional()
  .transform((v) => v === "true");

const selfWorkingDaysSchema = z.object({
  start: isoDate,
  end: isoDate,
  start_half_day: queryFlag,
  end_half_day: queryFlag,
});

me.get("/leave/types", async (c) => {
  const tenant = c.get("tenant");
  const self = await resolveSelf(c);
  if ("response" in self) return self.response;
  // Active types only: an employee should not be offered leave the tenant has
  // retired.
  return c.json({ leave_types: await listLeaveTypes(c.env.DB, tenant.tenant_id) });
});

me.get("/leave/balances", async (c) => {
  const tenant = c.get("tenant");
  const self = await resolveSelf(c);
  if ("response" in self) return self.response;

  const asOf = c.req.query("as_of");
  if (asOf !== undefined && !ISO_DATE.test(asOf)) {
    return c.json({ error: "as_of must be YYYY-MM-DD", code: "invalid_request" }, 400);
  }
  try {
    return c.json(
      await getBalances(c.env.DB, tenant.tenant_id, self.employee.employee_id, { as_of: asOf }),
    );
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

me.get("/leave/holidays", async (c) => {
  const tenant = c.get("tenant");
  const self = await resolveSelf(c);
  if ("response" in self) return self.response;

  const raw = c.req.query("year") ?? String(new Date().getUTCFullYear());
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return c.json({ error: "year must be a four-digit year", code: "invalid_request" }, 400);
  }

  // The employee's own work state decides the set — a Penang employee and a
  // Sarawak employee in the same tenant see different holidays.
  const profile = await getLeaveProfile(c.env.DB, tenant.tenant_id, self.employee.employee_id);
  const set = (await effectiveHolidays(c.env.DB, tenant.tenant_id, profile.work_state, [year])).get(
    year,
  )!;
  return c.json({
    year,
    work_state: profile.work_state,
    holidays: holidayList(set),
    holiday_data_available: set.dataAvailable,
    holiday_data_provisional: set.provisional,
    source_note: set.sourceNote,
  });
});

me.get("/leave/working-days", zValidator("query", selfWorkingDaysSchema), async (c) => {
  const tenant = c.get("tenant");
  const self = await resolveSelf(c);
  if ("response" in self) return self.response;
  try {
    return c.json(
      await workingDaysFor(c.env.DB, tenant.tenant_id, {
        ...c.req.valid("query"),
        employee_id: self.employee.employee_id,
      }),
    );
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});
