import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireCapability } from "../middleware/capability";
import {
  createLeaveType,
  createPolicy,
  deleteTenantHoliday,
  effectiveHolidays,
  getLeaveSettings,
  getLeaveProfile,
  listAssignments,
  listLeaveTypes,
  listPolicies,
  listTenantHolidays,
  updateLeaveSettings,
  updateLeaveType,
  updatePolicy,
  upsertAssignment,
  upsertLeaveProfile,
  upsertTenantHoliday,
} from "../../modules/leave/service";
import { addAdjustment, closeLeaveYear, getBalances } from "../../modules/leave/balances";
import { countWorkingDays } from "../../modules/leave/workdays";
import { holidayList } from "../../modules/leave/holidays/resolve";
import { MY_STATES } from "../../modules/leave/holidays/states";
import { SHIPPED_YEARS } from "../../modules/leave/holidays/data";
import { statutoryBands, STATUTORY_BASES } from "../../modules/leave/statutory";
import { LeaveError } from "../../modules/leave/types";
import { yearOf } from "../../modules/leave/dates";

/**
 * Leave configuration and balances, mounted at /v1/people/leave.
 *
 * Gated on the `people` module by the mount table in `src/index.ts` — reads
 * need `people:read`, writes `people:write`. That is the correct bar: leave
 * policy is HR administration over the whole directory, and the self-service
 * `employee` tier reaches its *own* balance through /v1/me/leave instead,
 * exactly as it reads its own record through /v1/me/employee.
 *
 * Year-close is held to a higher bar again (`admin:write`) because it writes
 * irreversible carry-forward rows for every employee at once.
 *
 * **No route here can reject an entitlement for being below the Employment Act
 * minimum.** Policy writes return 200/201 with a `warnings` array alongside the
 * saved policy. See src/modules/leave/statutory.ts.
 */
export const leave = new Hono<AuthedEnv>();

const yearCloseGuard = requireCapability("admin:write");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO_DATE, "must be YYYY-MM-DD");
const yearSchema = z.coerce.number().int().min(2000).max(2100);

const workWeekSchema = z
  .array(z.number().min(0).max(1))
  .length(7, "work_week is 7 day fractions, index 0 = Sunday");

const employmentTypeSchema = z.enum(["full_time", "part_time", "contract", "intern"]);
const accrualMethodSchema = z.enum(["annual_upfront", "monthly_accrual", "on_anniversary"]);
const statutoryBasisSchema = z.enum([
  "annual",
  "sick",
  "hospitalisation",
  "maternity",
  "paternity",
]);

const createTypeSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_]+$/, "code must be lowercase letters, digits and underscores"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  is_paid: z.boolean().optional(),
  requires_attachment: z.boolean().optional(),
  max_consecutive_days: z.number().int().positive().nullish(),
  allows_half_day: z.boolean().optional(),
  carry_forward_allowed: z.boolean().optional(),
  allow_negative_balance: z.boolean().optional(),
  statutory_basis: statutoryBasisSchema.nullish(),
});

const patchTypeSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable(),
    is_paid: z.boolean(),
    requires_attachment: z.boolean(),
    max_consecutive_days: z.number().int().positive().nullable(),
    allows_half_day: z.boolean(),
    carry_forward_allowed: z.boolean(),
    allow_negative_balance: z.boolean(),
    statutory_basis: statutoryBasisSchema.nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

const bandSchema = z.object({
  employment_type: employmentTypeSchema.nullish(),
  min_months_service: z.number().int().min(0).optional(),
  max_months_service: z.number().int().positive().nullish(),
  entitlement_days: z.number().min(0).max(366),
});

const createPolicySchema = z.object({
  leave_type_id: z.string().min(1),
  name: z.string().min(1).max(200),
  accrual_method: accrualMethodSchema.optional(),
  carry_forward_max_days: z.number().min(0).max(366).optional(),
  carry_forward_expiry_months: z.number().int().min(1).max(12).nullish(),
  is_default: z.boolean().optional(),
  bands: z.array(bandSchema).min(1),
});

const patchPolicySchema = z
  .object({
    name: z.string().min(1).max(200),
    accrual_method: accrualMethodSchema,
    carry_forward_max_days: z.number().min(0).max(366),
    carry_forward_expiry_months: z.number().int().min(1).max(12).nullable(),
    is_default: z.boolean(),
    archived: z.boolean(),
    bands: z.array(bandSchema).min(1),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

const profileSchema = z
  .object({
    employee_id: z.string().min(1),
    work_state: z.string().length(3).nullable().optional(),
    work_week: workWeekSchema.nullable().optional(),
  })
  .refine((p) => p.work_state !== undefined || p.work_week !== undefined, {
    message: "nothing to set",
  });

const assignmentSchema = z.object({
  employee_id: z.string().min(1),
  leave_type_id: z.string().min(1),
  policy_id: z.string().min(1),
  entitlement_days_override: z.number().min(0).max(366).nullish(),
});

const holidaySchema = z.object({
  holiday_date: isoDate,
  name: z.string().min(1).max(200),
  // 'national' or a 3-letter state code; the service validates against the
  // registry so the error is a consistent LeaveError, not a Zod enum dump.
  scope: z.string().min(3).max(20),
  observed: z.boolean().optional(),
  note: z.string().max(500).nullish(),
});

// NOT z.coerce.boolean(): it treats any non-empty string as true, so
// `?start_half_day=false` would silently mean true. An explicit "true" test is
// the only reading that cannot surprise a caller.
const queryFlag = z
  .string()
  .optional()
  .transform((v) => v === "true");

const workingDaysQuerySchema = z.object({
  employee_id: z.string().min(1),
  start: isoDate,
  end: isoDate,
  start_half_day: queryFlag,
  end_half_day: queryFlag,
});

const balancesQuerySchema = z.object({
  employee_id: z.string().min(1),
  as_of: isoDate.optional(),
  leave_type_id: z.string().optional(),
});

const yearCloseSchema = z.object({
  leave_year: z.number().int().min(2000).max(2100),
  employee_id: z.string().optional(),
  dry_run: z.boolean().optional(),
});

const adjustmentSchema = z.object({
  employee_id: z.string().min(1),
  leave_type_id: z.string().min(1),
  leave_year: z.number().int().min(2000).max(2100),
  days: z.number().min(-366).max(366),
  kind: z.enum(["adjustment", "encashment"]).optional(),
  note: z.string().max(500).nullish(),
});

export function leaveErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof LeaveError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

// ---- Settings ----------------------------------------------------------

leave.get("/settings", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ settings: await getLeaveSettings(c.env.DB, tenant.tenant_id) });
});

leave.put("/settings", zValidator("json", z.object({ work_week: workWeekSchema })), async (c) => {
  const tenant = c.get("tenant");
  try {
    const settings = await updateLeaveSettings(c.env.DB, tenant.tenant_id, {
      work_week: c.req.valid("json").work_week as never,
    });
    return c.json({ settings });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

// ---- Leave types -------------------------------------------------------

leave.get("/types", async (c) => {
  const tenant = c.get("tenant");
  const includeArchived = c.req.query("include_archived") === "true";
  return c.json({
    leave_types: await listLeaveTypes(c.env.DB, tenant.tenant_id, {
      include_archived: includeArchived,
    }),
  });
});

leave.post("/types", zValidator("json", createTypeSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const leaveType = await createLeaveType(c.env.DB, tenant.tenant_id, c.req.valid("json"));
    return c.json({ leave_type: leaveType }, 201);
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.patch("/types/:id", zValidator("json", patchTypeSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const leaveType = await updateLeaveType(
      c.env.DB,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    return c.json({ leave_type: leaveType });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

// ---- Policies ----------------------------------------------------------

leave.get("/policies", async (c) => {
  const tenant = c.get("tenant");
  return c.json({
    policies: await listPolicies(c.env.DB, tenant.tenant_id, {
      leave_type_id: c.req.query("leave_type_id"),
      include_archived: c.req.query("include_archived") === "true",
    }),
  });
});

leave.post("/policies", zValidator("json", createPolicySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const result = await createPolicy(c.env.DB, tenant.tenant_id, c.req.valid("json"));
    // 201 WITH warnings, never 422 because of them — a below-minimum
    // entitlement is the tenant's call to make.
    return c.json({ policy: result.policy, warnings: result.warnings }, 201);
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.patch("/policies/:id", zValidator("json", patchPolicySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const result = await updatePolicy(
      c.env.DB,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    return c.json({ policy: result.policy, warnings: result.warnings });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

/** The Employment Act tables the warnings are generated from, so the console
 * can show "statutory minimum: 12 days" next to the field. */
leave.get("/statutory-minimums", (c) =>
  c.json({
    statutory_minimums: STATUTORY_BASES.map((basis) => ({ basis, bands: statutoryBands(basis) })),
    note:
      "Employment Act 1955 as amended 2022. A seed default and a warning, not an enforced " +
      "floor — entitlements below these values save normally.",
  }),
);

// ---- Employee profiles and assignments ---------------------------------

leave.get("/employee-profiles", async (c) => {
  const employeeId = c.req.query("employee_id");
  if (!employeeId) return c.json({ error: "employee_id is required", code: "invalid_request" }, 400);
  const tenant = c.get("tenant");
  try {
    return c.json({ profile: await getLeaveProfile(c.env.DB, tenant.tenant_id, employeeId) });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.put("/employee-profiles", zValidator("json", profileSchema), async (c) => {
  const tenant = c.get("tenant");
  const { employee_id: employeeId, ...rest } = c.req.valid("json");
  try {
    const profile = await upsertLeaveProfile(c.env.DB, tenant.tenant_id, employeeId, rest as never);
    return c.json({ profile });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.get("/assignments", async (c) => {
  const employeeId = c.req.query("employee_id");
  if (!employeeId) return c.json({ error: "employee_id is required", code: "invalid_request" }, 400);
  const tenant = c.get("tenant");
  return c.json({ assignments: await listAssignments(c.env.DB, tenant.tenant_id, employeeId) });
});

leave.put("/assignments", zValidator("json", assignmentSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    return c.json({
      assignment: await upsertAssignment(c.env.DB, tenant.tenant_id, c.req.valid("json")),
    });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

// ---- Public holidays ---------------------------------------------------

/** Malaysian states and the years the shipped calendar covers — what a console
 * state picker and year picker are built from. */
leave.get("/states", (c) =>
  c.json({ states: MY_STATES, shipped_holiday_years: SHIPPED_YEARS }),
);

leave.get("/holidays", async (c) => {
  const tenant = c.get("tenant");
  const parsedYear = yearSchema.safeParse(c.req.query("year") ?? new Date().getUTCFullYear());
  if (!parsedYear.success) {
    return c.json({ error: "year must be a four-digit year", code: "invalid_request" }, 400);
  }
  const year = parsedYear.data;
  const state = c.req.query("state") ?? null;

  const sets = await effectiveHolidays(c.env.DB, tenant.tenant_id, state, [year]);
  const set = sets.get(year)!;
  return c.json({
    year,
    state,
    holidays: holidayList(set),
    // Never let an unshipped year read as "no public holidays this year".
    holiday_data_available: set.dataAvailable,
    holiday_data_provisional: set.provisional,
    source_note: set.sourceNote,
    // The raw deltas too, so a console can show what this tenant changed.
    overrides: await listTenantHolidays(c.env.DB, tenant.tenant_id, year),
  });
});

leave.post("/holidays", zValidator("json", holidaySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const holiday = await upsertTenantHoliday(c.env.DB, tenant.tenant_id, c.req.valid("json"));
    return c.json({ holiday }, 201);
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.delete("/holidays/:id", async (c) => {
  const tenant = c.get("tenant");
  try {
    await deleteTenantHoliday(c.env.DB, tenant.tenant_id, c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

// ---- Working days and balances -----------------------------------------

leave.get("/working-days", zValidator("query", workingDaysQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const q = c.req.valid("query");
  try {
    return c.json(await workingDaysFor(c.env.DB, tenant.tenant_id, q));
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.get("/balances", zValidator("query", balancesQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const q = c.req.valid("query");
  try {
    return c.json(
      await getBalances(c.env.DB, tenant.tenant_id, q.employee_id, {
        as_of: q.as_of,
        leave_type_id: q.leave_type_id,
      }),
    );
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.post("/adjustments", zValidator("json", adjustmentSchema), async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  try {
    return c.json(
      await addAdjustment(c.env.DB, tenant.tenant_id, {
        ...c.req.valid("json"),
        created_by: actor?.type === "user" ? actor.id : null,
      }),
      201,
    );
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

leave.post("/year-close", yearCloseGuard, zValidator("json", yearCloseSchema), async (c) => {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  const input = c.req.valid("json");
  try {
    const results = await closeLeaveYear(c.env.DB, tenant.tenant_id, {
      ...input,
      created_by: actor?.type === "user" ? actor.id : null,
    });
    return c.json({ leave_year: input.leave_year, dry_run: input.dry_run === true, results });
  } catch (err) {
    return leaveErrorResponse(c, err);
  }
});

/**
 * Shared by the HR and self-service working-day previews: resolve the
 * employee's work week and holiday set, then count. Exported so /v1/me/leave
 * gets exactly the same arithmetic rather than a second implementation that
 * can drift.
 */
export async function workingDaysFor(
  db: D1Database,
  tenantId: string,
  q: {
    employee_id: string;
    start: string;
    end: string;
    start_half_day?: boolean;
    end_half_day?: boolean;
  },
) {
  const [settings, profile] = await Promise.all([
    getLeaveSettings(db, tenantId),
    getLeaveProfile(db, tenantId, q.employee_id),
  ]);
  const years: number[] = [];
  for (let y = yearOf(q.start); y <= yearOf(q.end); y += 1) years.push(y);
  const byYear = await effectiveHolidays(db, tenantId, profile.work_state, years);

  const merged = {
    byDate: new Map(years.flatMap((y) => [...(byYear.get(y)?.byDate ?? new Map())])),
    dataAvailable: years.every((y) => byYear.get(y)?.dataAvailable ?? false),
    provisional: years.some((y) => byYear.get(y)?.provisional ?? false),
    sourceNote: null,
  };

  return {
    start: q.start,
    end: q.end,
    work_state: profile.work_state,
    work_week: profile.work_week ?? settings.work_week,
    ...countWorkingDays(q.start, q.end, profile.work_week ?? settings.work_week, merged, {
      start_half_day: q.start_half_day,
      end_half_day: q.end_half_day,
    }),
  };
}
