import { ulid } from "../../lib/ulid";
import { seedLeaveDefaults } from "./defaults";
import { isIsoDate, yearOf } from "./dates";
import { isHolidayScope, isStateCode } from "./holidays/states";
import { resolveHolidays, type HolidaySet } from "./holidays/resolve";
import { parseWorkWeek } from "./workdays";
import { warningsForPolicy } from "./statutory";
import {
  DEFAULT_WORK_WEEK,
  LeaveError,
  type AccrualMethod,
  type EmployeeLeaveProfile,
  type EmploymentType,
  type LeaveAssignment,
  type LeavePolicy,
  type LeaveSettings,
  type LeaveType,
  type PolicyBand,
  type StatutoryBasis,
  type StatutoryWarning,
  type TenantHoliday,
  type WorkWeek,
} from "./types";

/**
 * Leave configuration service (PRD-006b).
 *
 * Everything a tenant can *set* lives here — types, policies, entitlement
 * bands, employee assignments, work weeks, work states and holiday overrides.
 * The things a tenant can only *ask about* — working-day counts and balances —
 * live in `workdays.ts` and `balances.ts`, which read this configuration.
 *
 * The defaults seed is lazy: any read of types or policies calls
 * `seedLeaveDefaults` first, so a tenant that has never touched leave still
 * gets a working Malaysian configuration on first page load rather than an
 * empty screen and a support ticket. It runs once (see `defaults.ts`).
 */

const TYPE_COLUMNS =
  "leave_type_id, code, name, description, is_paid, requires_attachment, max_consecutive_days, " +
  "allows_half_day, carry_forward_allowed, allow_negative_balance, statutory_basis, archived_at, " +
  "created_at, updated_at";

interface LeaveTypeRow {
  leave_type_id: string;
  code: string;
  name: string;
  description: string | null;
  is_paid: number;
  requires_attachment: number;
  max_consecutive_days: number | null;
  allows_half_day: number;
  carry_forward_allowed: number;
  allow_negative_balance: number;
  statutory_basis: StatutoryBasis | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function toLeaveType(row: LeaveTypeRow): LeaveType {
  return {
    ...row,
    is_paid: row.is_paid === 1,
    requires_attachment: row.requires_attachment === 1,
    allows_half_day: row.allows_half_day === 1,
    carry_forward_allowed: row.carry_forward_allowed === 1,
    allow_negative_balance: row.allow_negative_balance === 1,
  };
}

// ---- Settings ----------------------------------------------------------

export async function getLeaveSettings(db: D1Database, tenantId: string): Promise<LeaveSettings> {
  const row = await db
    .prepare("SELECT work_week, defaults_seeded_at FROM leave_settings WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ work_week: string; defaults_seeded_at: string | null }>();
  if (!row) return { work_week: DEFAULT_WORK_WEEK, defaults_seeded_at: null };
  return { work_week: parseWorkWeek(row.work_week), defaults_seeded_at: row.defaults_seeded_at };
}

export async function updateLeaveSettings(
  db: D1Database,
  tenantId: string,
  input: { work_week: WorkWeek },
): Promise<LeaveSettings> {
  const week = parseWorkWeek(input.work_week);
  await db.prepare("INSERT OR IGNORE INTO leave_settings (tenant_id) VALUES (?)").bind(tenantId).run();
  await db
    .prepare(
      `UPDATE leave_settings SET work_week = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE tenant_id = ?`,
    )
    .bind(JSON.stringify(week), tenantId)
    .run();
  return getLeaveSettings(db, tenantId);
}

// ---- Leave types -------------------------------------------------------

export async function listLeaveTypes(
  db: D1Database,
  tenantId: string,
  opts: { include_archived?: boolean } = {},
): Promise<LeaveType[]> {
  await seedLeaveDefaults(db, tenantId);
  const where = opts.include_archived ? "" : " AND archived_at IS NULL";
  const { results } = await db
    .prepare(`SELECT ${TYPE_COLUMNS} FROM leave_types WHERE tenant_id = ?${where} ORDER BY code`)
    .bind(tenantId)
    .all<LeaveTypeRow>();
  return results.map(toLeaveType);
}

export async function getLeaveType(
  db: D1Database,
  tenantId: string,
  leaveTypeId: string,
): Promise<LeaveType | null> {
  const row = await db
    .prepare(`SELECT ${TYPE_COLUMNS} FROM leave_types WHERE tenant_id = ? AND leave_type_id = ?`)
    .bind(tenantId, leaveTypeId)
    .first<LeaveTypeRow>();
  return row ? toLeaveType(row) : null;
}

export interface CreateLeaveTypeInput {
  code: string;
  name: string;
  description?: string | null;
  is_paid?: boolean;
  requires_attachment?: boolean;
  max_consecutive_days?: number | null;
  allows_half_day?: boolean;
  carry_forward_allowed?: boolean;
  allow_negative_balance?: boolean;
  statutory_basis?: StatutoryBasis | null;
}

export async function createLeaveType(
  db: D1Database,
  tenantId: string,
  input: CreateLeaveTypeInput,
): Promise<LeaveType> {
  await seedLeaveDefaults(db, tenantId);
  const id = `lvt_${ulid()}`;
  try {
    await db
      .prepare(
        `INSERT INTO leave_types (
           leave_type_id, tenant_id, code, name, description, is_paid, requires_attachment,
           max_consecutive_days, allows_half_day, carry_forward_allowed, allow_negative_balance,
           statutory_basis
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        tenantId,
        input.code,
        input.name,
        input.description ?? null,
        input.is_paid === false ? 0 : 1,
        input.requires_attachment ? 1 : 0,
        input.max_consecutive_days ?? null,
        input.allows_half_day === false ? 0 : 1,
        input.carry_forward_allowed ? 1 : 0,
        input.allow_negative_balance ? 1 : 0,
        input.statutory_basis ?? null,
      )
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new LeaveError("code_taken", `leave type code '${input.code}' already exists`, 409);
    }
    throw err;
  }
  return (await getLeaveType(db, tenantId, id))!;
}

const TYPE_PATCH_COLUMNS: Record<string, "bool" | "raw"> = {
  name: "raw",
  description: "raw",
  is_paid: "bool",
  requires_attachment: "bool",
  max_consecutive_days: "raw",
  allows_half_day: "bool",
  carry_forward_allowed: "bool",
  allow_negative_balance: "bool",
  statutory_basis: "raw",
};

export async function updateLeaveType(
  db: D1Database,
  tenantId: string,
  leaveTypeId: string,
  patch: Record<string, unknown> & { archived?: boolean },
): Promise<LeaveType> {
  const existing = await getLeaveType(db, tenantId, leaveTypeId);
  if (!existing) throw new LeaveError("not_found", "leave type not found", 404);

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const [key, kind] of Object.entries(TYPE_PATCH_COLUMNS)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sets.push(`${key} = ?`);
    binds.push(kind === "bool" ? (value ? 1 : 0) : (value as string | number | null));
  }
  // Retirement is archival, never deletion — the no-hard-delete convention.
  // Historic requests must keep resolving their type.
  if (patch.archived !== undefined) {
    sets.push(
      patch.archived
        ? "archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
        : "archived_at = NULL",
    );
  }
  if (sets.length === 0) throw new LeaveError("invalid_request", "empty patch", 400);

  await db
    .prepare(
      `UPDATE leave_types SET ${sets.join(", ")},
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE tenant_id = ? AND leave_type_id = ?`,
    )
    .bind(...binds, tenantId, leaveTypeId)
    .run();
  return (await getLeaveType(db, tenantId, leaveTypeId))!;
}

// ---- Policies ----------------------------------------------------------

interface PolicyRow {
  policy_id: string;
  leave_type_id: string;
  name: string;
  accrual_method: AccrualMethod;
  carry_forward_max_days: number;
  carry_forward_expiry_months: number | null;
  is_default: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const POLICY_COLUMNS =
  "policy_id, leave_type_id, name, accrual_method, carry_forward_max_days, " +
  "carry_forward_expiry_months, is_default, archived_at, created_at, updated_at";

async function bandsFor(
  db: D1Database,
  tenantId: string,
  policyIds: readonly string[],
): Promise<Map<string, PolicyBand[]>> {
  const byPolicy = new Map<string, PolicyBand[]>();
  if (policyIds.length === 0) return byPolicy;
  const placeholders = policyIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT policy_id, band_id, employment_type, min_months_service, max_months_service,
              entitlement_days
       FROM leave_policy_bands
       WHERE tenant_id = ? AND policy_id IN (${placeholders})
       ORDER BY min_months_service`,
    )
    .bind(tenantId, ...policyIds)
    .all<PolicyBand & { policy_id: string }>();
  for (const row of results) {
    const { policy_id, ...band } = row;
    const list = byPolicy.get(policy_id) ?? [];
    list.push(band);
    byPolicy.set(policy_id, list);
  }
  return byPolicy;
}

function toPolicy(row: PolicyRow, bands: PolicyBand[]): LeavePolicy {
  return { ...row, is_default: row.is_default === 1, bands };
}

export async function listPolicies(
  db: D1Database,
  tenantId: string,
  filter: { leave_type_id?: string; include_archived?: boolean } = {},
): Promise<LeavePolicy[]> {
  await seedLeaveDefaults(db, tenantId);
  const clauses = ["tenant_id = ?"];
  const binds: string[] = [tenantId];
  if (filter.leave_type_id) {
    clauses.push("leave_type_id = ?");
    binds.push(filter.leave_type_id);
  }
  if (!filter.include_archived) clauses.push("archived_at IS NULL");
  const { results } = await db
    .prepare(`SELECT ${POLICY_COLUMNS} FROM leave_policies WHERE ${clauses.join(" AND ")} ORDER BY name`)
    .bind(...binds)
    .all<PolicyRow>();
  const bands = await bandsFor(db, tenantId, results.map((r) => r.policy_id));
  return results.map((r) => toPolicy(r, bands.get(r.policy_id) ?? []));
}

export async function getPolicy(
  db: D1Database,
  tenantId: string,
  policyId: string,
): Promise<LeavePolicy | null> {
  const row = await db
    .prepare(`SELECT ${POLICY_COLUMNS} FROM leave_policies WHERE tenant_id = ? AND policy_id = ?`)
    .bind(tenantId, policyId)
    .first<PolicyRow>();
  if (!row) return null;
  const bands = await bandsFor(db, tenantId, [policyId]);
  return toPolicy(row, bands.get(policyId) ?? []);
}

export interface PolicyBandInput {
  employment_type?: EmploymentType | null;
  min_months_service?: number;
  max_months_service?: number | null;
  entitlement_days: number;
}

export interface CreatePolicyInput {
  leave_type_id: string;
  name: string;
  accrual_method?: AccrualMethod;
  carry_forward_max_days?: number;
  carry_forward_expiry_months?: number | null;
  is_default?: boolean;
  bands: PolicyBandInput[];
}

/**
 * A policy and its bands, plus any statutory warnings.
 *
 * The warnings ride along with a **successful** write. Nothing here can refuse
 * a below-minimum entitlement — see `statutory.ts` for why that is deliberate.
 */
export interface PolicyWriteResult {
  policy: LeavePolicy;
  warnings: StatutoryWarning[];
}

function bandStatements(
  db: D1Database,
  tenantId: string,
  policyId: string,
  bands: readonly PolicyBandInput[],
): D1PreparedStatement[] {
  return bands.map((band) =>
    db
      .prepare(
        `INSERT INTO leave_policy_bands (
           band_id, tenant_id, policy_id, employment_type, min_months_service,
           max_months_service, entitlement_days
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `lvb_${ulid()}`,
        tenantId,
        policyId,
        band.employment_type ?? null,
        band.min_months_service ?? 0,
        band.max_months_service ?? null,
        band.entitlement_days,
      ),
  );
}

async function warningsFor(
  db: D1Database,
  tenantId: string,
  leaveTypeId: string,
  bands: readonly PolicyBandInput[],
): Promise<StatutoryWarning[]> {
  const type = await getLeaveType(db, tenantId, leaveTypeId);
  return warningsForPolicy(
    type?.statutory_basis ?? null,
    bands.map((b) => ({
      employment_type: b.employment_type ?? null,
      min_months_service: b.min_months_service ?? 0,
      max_months_service: b.max_months_service ?? null,
      entitlement_days: b.entitlement_days,
    })),
  );
}

export async function createPolicy(
  db: D1Database,
  tenantId: string,
  input: CreatePolicyInput,
): Promise<PolicyWriteResult> {
  const type = await getLeaveType(db, tenantId, input.leave_type_id);
  if (!type) throw new LeaveError("invalid_leave_type", "unknown leave_type_id");
  if (input.bands.length === 0) {
    throw new LeaveError("invalid_request", "a policy needs at least one entitlement band", 400);
  }

  const policyId = `lvp_${ulid()}`;
  // Clearing the incumbent default has to happen before the insert: the
  // partial unique index allows only one live default per leave type.
  if (input.is_default) await clearDefault(db, tenantId, input.leave_type_id);

  await db.batch([
    db
      .prepare(
        `INSERT INTO leave_policies (
           policy_id, tenant_id, leave_type_id, name, accrual_method,
           carry_forward_max_days, carry_forward_expiry_months, is_default
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        policyId,
        tenantId,
        input.leave_type_id,
        input.name,
        input.accrual_method ?? "annual_upfront",
        input.carry_forward_max_days ?? 0,
        input.carry_forward_expiry_months ?? null,
        input.is_default ? 1 : 0,
      ),
    ...bandStatements(db, tenantId, policyId, input.bands),
  ]);

  return {
    policy: (await getPolicy(db, tenantId, policyId))!,
    warnings: await warningsFor(db, tenantId, input.leave_type_id, input.bands),
  };
}

async function clearDefault(db: D1Database, tenantId: string, leaveTypeId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE leave_policies SET is_default = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE tenant_id = ? AND leave_type_id = ? AND is_default = 1`,
    )
    .bind(tenantId, leaveTypeId)
    .run();
}

export interface UpdatePolicyInput {
  name?: string;
  accrual_method?: AccrualMethod;
  carry_forward_max_days?: number;
  carry_forward_expiry_months?: number | null;
  is_default?: boolean;
  archived?: boolean;
  /** Bands are replaced wholesale when present — a band list is a single
   * editable unit in the console, and a per-band diff would let a partial
   * failure leave a policy with overlapping windows. */
  bands?: PolicyBandInput[];
}

export async function updatePolicy(
  db: D1Database,
  tenantId: string,
  policyId: string,
  patch: UpdatePolicyInput,
): Promise<PolicyWriteResult> {
  const existing = await getPolicy(db, tenantId, policyId);
  if (!existing) throw new LeaveError("not_found", "policy not found", 404);
  if (patch.bands && patch.bands.length === 0) {
    throw new LeaveError("invalid_request", "a policy needs at least one entitlement band", 400);
  }

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (patch.name !== undefined) (sets.push("name = ?"), binds.push(patch.name));
  if (patch.accrual_method !== undefined) {
    sets.push("accrual_method = ?");
    binds.push(patch.accrual_method);
  }
  if (patch.carry_forward_max_days !== undefined) {
    sets.push("carry_forward_max_days = ?");
    binds.push(patch.carry_forward_max_days);
  }
  if (patch.carry_forward_expiry_months !== undefined) {
    sets.push("carry_forward_expiry_months = ?");
    binds.push(patch.carry_forward_expiry_months);
  }
  if (patch.is_default !== undefined) {
    if (patch.is_default) await clearDefault(db, tenantId, existing.leave_type_id);
    sets.push("is_default = ?");
    binds.push(patch.is_default ? 1 : 0);
  }
  if (patch.archived !== undefined) {
    sets.push(
      patch.archived ? "archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : "archived_at = NULL",
    );
    // An archived policy cannot also be the default anyone falls back to.
    if (patch.archived) sets.push("is_default = 0");
  }

  const statements: D1PreparedStatement[] = [];
  if (sets.length > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE leave_policies SET ${sets.join(", ")},
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE tenant_id = ? AND policy_id = ?`,
        )
        .bind(...binds, tenantId, policyId),
    );
  }
  if (patch.bands) {
    statements.push(
      db
        .prepare("DELETE FROM leave_policy_bands WHERE tenant_id = ? AND policy_id = ?")
        .bind(tenantId, policyId),
      ...bandStatements(db, tenantId, policyId, patch.bands),
    );
  }
  if (statements.length === 0) throw new LeaveError("invalid_request", "empty patch", 400);
  await db.batch(statements);

  const policy = (await getPolicy(db, tenantId, policyId))!;
  return {
    policy,
    warnings: await warningsFor(db, tenantId, existing.leave_type_id, patch.bands ?? policy.bands),
  };
}

// ---- Employee profiles and assignments ---------------------------------

async function assertEmployee(db: D1Database, tenantId: string, employeeId: string): Promise<void> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM employees WHERE tenant_id = ? AND employee_id = ?")
    .bind(tenantId, employeeId)
    .first<{ ok: number }>();
  if (!row) throw new LeaveError("invalid_employee", "unknown employee_id");
}

export async function getLeaveProfile(
  db: D1Database,
  tenantId: string,
  employeeId: string,
): Promise<EmployeeLeaveProfile> {
  const row = await db
    .prepare(
      "SELECT work_state, work_week FROM employee_leave_profiles WHERE tenant_id = ? AND employee_id = ?",
    )
    .bind(tenantId, employeeId)
    .first<{ work_state: string | null; work_week: string | null }>();
  return {
    employee_id: employeeId,
    work_state: row?.work_state ?? null,
    work_week: row?.work_week ? parseWorkWeek(row.work_week) : null,
  };
}

export async function upsertLeaveProfile(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  input: { work_state?: string | null; work_week?: WorkWeek | null },
): Promise<EmployeeLeaveProfile> {
  await assertEmployee(db, tenantId, employeeId);
  if (input.work_state !== undefined && input.work_state !== null && !isStateCode(input.work_state)) {
    throw new LeaveError(
      "invalid_request",
      `unknown work_state '${input.work_state}' — expected a Malaysian state or federal territory code`,
      400,
    );
  }
  const week = input.work_week == null ? null : JSON.stringify(parseWorkWeek(input.work_week));

  const current = await getLeaveProfile(db, tenantId, employeeId);
  const workState = input.work_state === undefined ? current.work_state : input.work_state;
  const workWeek =
    input.work_week === undefined
      ? current.work_week === null
        ? null
        : JSON.stringify(current.work_week)
      : week;

  await db
    .prepare(
      `INSERT INTO employee_leave_profiles (tenant_id, employee_id, work_state, work_week)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, employee_id) DO UPDATE SET
         work_state = excluded.work_state,
         work_week = excluded.work_week,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(tenantId, employeeId, workState, workWeek)
    .run();
  return getLeaveProfile(db, tenantId, employeeId);
}

export async function listAssignments(
  db: D1Database,
  tenantId: string,
  employeeId: string,
): Promise<LeaveAssignment[]> {
  const { results } = await db
    .prepare(
      `SELECT employee_id, leave_type_id, policy_id, entitlement_days_override
       FROM employee_leave_assignments WHERE tenant_id = ? AND employee_id = ?`,
    )
    .bind(tenantId, employeeId)
    .all<LeaveAssignment>();
  return results;
}

export async function upsertAssignment(
  db: D1Database,
  tenantId: string,
  input: {
    employee_id: string;
    leave_type_id: string;
    policy_id: string;
    entitlement_days_override?: number | null;
  },
): Promise<LeaveAssignment> {
  await assertEmployee(db, tenantId, input.employee_id);
  const policy = await getPolicy(db, tenantId, input.policy_id);
  if (!policy) throw new LeaveError("invalid_policy", "unknown policy_id");
  if (policy.leave_type_id !== input.leave_type_id) {
    throw new LeaveError("invalid_policy", "policy belongs to a different leave type");
  }
  if (policy.archived_at) {
    throw new LeaveError("archived", "cannot assign an archived policy", 409);
  }

  await db
    .prepare(
      `INSERT INTO employee_leave_assignments (
         tenant_id, employee_id, leave_type_id, policy_id, entitlement_days_override
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, employee_id, leave_type_id) DO UPDATE SET
         policy_id = excluded.policy_id,
         entitlement_days_override = excluded.entitlement_days_override,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(
      tenantId,
      input.employee_id,
      input.leave_type_id,
      input.policy_id,
      input.entitlement_days_override ?? null,
    )
    .run();

  return {
    employee_id: input.employee_id,
    leave_type_id: input.leave_type_id,
    policy_id: input.policy_id,
    entitlement_days_override: input.entitlement_days_override ?? null,
  };
}

// ---- Public holidays ---------------------------------------------------

export async function listTenantHolidays(
  db: D1Database,
  tenantId: string,
  year?: number,
): Promise<TenantHoliday[]> {
  const clauses = ["tenant_id = ?"];
  const binds: (string | number)[] = [tenantId];
  if (year !== undefined) {
    clauses.push("holiday_date >= ? AND holiday_date <= ?");
    binds.push(`${year}-01-01`, `${year}-12-31`);
  }
  const { results } = await db
    .prepare(
      `SELECT holiday_id, holiday_date, name, scope, observed, note
       FROM public_holidays WHERE ${clauses.join(" AND ")} ORDER BY holiday_date`,
    )
    .bind(...binds)
    .all<Omit<TenantHoliday, "observed"> & { observed: number }>();
  return results.map((r) => ({ ...r, observed: r.observed === 1 }));
}

export async function upsertTenantHoliday(
  db: D1Database,
  tenantId: string,
  input: { holiday_date: string; name: string; scope: string; observed?: boolean; note?: string | null },
): Promise<TenantHoliday> {
  if (!isIsoDate(input.holiday_date)) {
    throw new LeaveError("invalid_request", "holiday_date must be a valid YYYY-MM-DD date", 400);
  }
  if (!isHolidayScope(input.scope)) {
    throw new LeaveError(
      "invalid_request",
      `unknown scope '${input.scope}' — expected 'national' or a Malaysian state code`,
      400,
    );
  }
  const observed = input.observed === false ? 0 : 1;
  // Upsert rather than insert: one ruling per date per scope is the table's
  // unique key, and re-posting the same override is what a console save does.
  await db
    .prepare(
      `INSERT INTO public_holidays (holiday_id, tenant_id, holiday_date, name, scope, observed, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, holiday_date, scope) DO UPDATE SET
         name = excluded.name, observed = excluded.observed, note = excluded.note,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(
      `hol_${ulid()}`,
      tenantId,
      input.holiday_date,
      input.name,
      input.scope,
      observed,
      input.note ?? null,
    )
    .run();

  const row = await db
    .prepare(
      `SELECT holiday_id, holiday_date, name, scope, observed, note FROM public_holidays
       WHERE tenant_id = ? AND holiday_date = ? AND scope = ?`,
    )
    .bind(tenantId, input.holiday_date, input.scope)
    .first<Omit<TenantHoliday, "observed"> & { observed: number }>();
  return { ...row!, observed: row!.observed === 1 };
}

export async function deleteTenantHoliday(
  db: D1Database,
  tenantId: string,
  holidayId: string,
): Promise<void> {
  const res = await db
    .prepare("DELETE FROM public_holidays WHERE tenant_id = ? AND holiday_id = ?")
    .bind(tenantId, holidayId)
    .run();
  // A tenant override is not business history — it is configuration, and
  // removing one restores the shipped calendar. So this is a real delete, not
  // an archive, unlike leave types.
  if (!res.meta.changes) throw new LeaveError("not_found", "holiday override not found", 404);
}

/**
 * The effective holiday set for one work state across one or more years.
 * The single entry point every day-counting path goes through.
 */
export async function effectiveHolidays(
  db: D1Database,
  tenantId: string,
  workState: string | null,
  years: readonly number[],
): Promise<Map<number, HolidaySet>> {
  const unique = [...new Set(years)].sort();
  const rows = await listTenantHolidays(db, tenantId);
  const byYear = new Map<number, HolidaySet>();
  for (const year of unique) {
    const inYear = rows.filter((r) => yearOf(r.holiday_date) === year);
    byYear.set(year, resolveHolidays(year, workState, inYear));
  }
  return byYear;
}
