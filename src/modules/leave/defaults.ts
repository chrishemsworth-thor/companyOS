import { ulid } from "../../lib/ulid";
import type { AccrualMethod, StatutoryBasis } from "./types";

/**
 * Malaysian leave defaults, seeded per tenant on first use.
 *
 * PRD-006: *"Seed Malaysian defaults — annual, sick, hospitalisation,
 * maternity, paternity, unpaid, compassionate — all editable, none
 * hardcoded."* Nothing downstream keys off these rows; `code` exists so the
 * seed is idempotent and so a tenant renaming "Sick" keeps its statutory
 * warning, and `statutory_basis` — not `code` — is what the warning uses.
 *
 * The seed runs **once**, guarded by `leave_settings.defaults_seeded_at`, so a
 * tenant who archives a type they do not offer does not find it back tomorrow.
 * Retirement is `archived_at`, per the system-wide no-hard-delete convention.
 *
 * Entitlements are the Employment Act 1955 minimums as amended in 2022 — a
 * defensible floor to start from, which the tenant is expected to raise to
 * whatever their contracts actually say.
 */

interface SeedBand {
  min_months_service: number;
  max_months_service: number | null;
  entitlement_days: number;
}

interface SeedType {
  code: string;
  name: string;
  description: string;
  is_paid: boolean;
  requires_attachment: boolean;
  max_consecutive_days: number | null;
  allows_half_day: boolean;
  carry_forward_allowed: boolean;
  allow_negative_balance: boolean;
  statutory_basis: StatutoryBasis | null;
  policy: {
    name: string;
    accrual_method: AccrualMethod;
    carry_forward_max_days: number;
    carry_forward_expiry_months: number | null;
    bands: SeedBand[];
  } | null;
}

export const MALAYSIAN_LEAVE_DEFAULTS: readonly SeedType[] = [
  {
    code: "annual",
    name: "Annual Leave",
    description: "Paid annual leave. Employment Act 1955 minimums by length of service.",
    is_paid: true,
    requires_attachment: false,
    max_consecutive_days: null,
    allows_half_day: true,
    // The one type Malaysian SMEs routinely carry forward, which is why the
    // default policy sets a cap rather than leaving it at zero.
    carry_forward_allowed: true,
    allow_negative_balance: false,
    statutory_basis: "annual",
    policy: {
      name: "Annual Leave — Employment Act minimum",
      accrual_method: "annual_upfront",
      // A cap, not a licence to hoard: 5 days is the common SME setting and
      // matches PRD-006's own carry-forward acceptance criterion.
      carry_forward_max_days: 5,
      // Use it by 31 March or lose it — the other common SME setting. Set to
      // null by a tenant whose carried days never lapse.
      carry_forward_expiry_months: 3,
      bands: [
        { min_months_service: 0, max_months_service: 24, entitlement_days: 8 },
        { min_months_service: 24, max_months_service: 60, entitlement_days: 12 },
        { min_months_service: 60, max_months_service: null, entitlement_days: 16 },
      ],
    },
  },
  {
    code: "sick",
    name: "Sick Leave",
    description: "Paid outpatient sick leave where hospitalisation is not necessary.",
    is_paid: true,
    // A medical certificate is the norm and the Act's own condition.
    requires_attachment: true,
    max_consecutive_days: null,
    allows_half_day: false,
    carry_forward_allowed: false,
    allow_negative_balance: false,
    statutory_basis: "sick",
    policy: {
      name: "Sick Leave — Employment Act minimum",
      accrual_method: "annual_upfront",
      carry_forward_max_days: 0,
      carry_forward_expiry_months: null,
      bands: [
        { min_months_service: 0, max_months_service: 24, entitlement_days: 14 },
        { min_months_service: 24, max_months_service: 60, entitlement_days: 18 },
        { min_months_service: 60, max_months_service: null, entitlement_days: 22 },
      ],
    },
  },
  {
    code: "hospitalisation",
    name: "Hospitalisation Leave",
    description: "Paid leave where hospitalisation is necessary. Up to 60 days a year.",
    is_paid: true,
    requires_attachment: true,
    max_consecutive_days: null,
    allows_half_day: false,
    carry_forward_allowed: false,
    allow_negative_balance: false,
    statutory_basis: "hospitalisation",
    policy: {
      name: "Hospitalisation Leave — Employment Act minimum",
      accrual_method: "annual_upfront",
      carry_forward_max_days: 0,
      carry_forward_expiry_months: null,
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 60 }],
    },
  },
  {
    code: "maternity",
    name: "Maternity Leave",
    description: "98 consecutive days of paid maternity leave (Employment Act, as amended 2022).",
    is_paid: true,
    requires_attachment: false,
    max_consecutive_days: null,
    allows_half_day: false,
    carry_forward_allowed: false,
    allow_negative_balance: false,
    statutory_basis: "maternity",
    policy: {
      name: "Maternity Leave — Employment Act minimum",
      accrual_method: "annual_upfront",
      carry_forward_max_days: 0,
      carry_forward_expiry_months: null,
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 98 }],
    },
  },
  {
    code: "paternity",
    name: "Paternity Leave",
    description: "7 consecutive days of paid paternity leave (Employment Act, as amended 2022).",
    is_paid: true,
    requires_attachment: false,
    max_consecutive_days: 7,
    allows_half_day: false,
    carry_forward_allowed: false,
    allow_negative_balance: false,
    statutory_basis: "paternity",
    policy: {
      name: "Paternity Leave — Employment Act minimum",
      accrual_method: "annual_upfront",
      carry_forward_max_days: 0,
      carry_forward_expiry_months: null,
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 7 }],
    },
  },
  {
    code: "compassionate",
    name: "Compassionate Leave",
    description: "Bereavement leave. Not statutory in Malaysia — 3 days is the common practice.",
    is_paid: true,
    requires_attachment: false,
    max_consecutive_days: null,
    allows_half_day: false,
    carry_forward_allowed: false,
    allow_negative_balance: false,
    // No statutory basis: no warning is ever produced for this type.
    statutory_basis: null,
    policy: {
      name: "Compassionate Leave — common practice",
      accrual_method: "annual_upfront",
      carry_forward_max_days: 0,
      carry_forward_expiry_months: null,
      bands: [{ min_months_service: 0, max_months_service: null, entitlement_days: 3 }],
    },
  },
  {
    code: "unpaid",
    name: "Unpaid Leave",
    description: "Leave without pay. No entitlement; the balance is expected to go negative.",
    is_paid: false,
    requires_attachment: false,
    max_consecutive_days: null,
    allows_half_day: true,
    carry_forward_allowed: false,
    // The one type where a negative balance is the point rather than an error.
    allow_negative_balance: true,
    statutory_basis: null,
    // No policy: unpaid leave has no entitlement to accrue.
    policy: null,
  },
];

/**
 * Seed the defaults for a tenant, once.
 *
 * Idempotent twice over: the `defaults_seeded_at` stamp short-circuits a repeat
 * call, and every insert is `INSERT OR IGNORE` on a natural key, so a
 * concurrent double-call cannot produce duplicates either.
 *
 * Returns true if this call did the seeding.
 */
export async function seedLeaveDefaults(db: D1Database, tenantId: string): Promise<boolean> {
  await db
    .prepare("INSERT OR IGNORE INTO leave_settings (tenant_id) VALUES (?)")
    .bind(tenantId)
    .run();

  const settings = await db
    .prepare("SELECT defaults_seeded_at FROM leave_settings WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ defaults_seeded_at: string | null }>();
  if (settings?.defaults_seeded_at) return false;

  const statements: D1PreparedStatement[] = [];

  for (const type of MALAYSIAN_LEAVE_DEFAULTS) {
    const leaveTypeId = `lvt_${ulid()}`;
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO leave_types (
             leave_type_id, tenant_id, code, name, description, is_paid, requires_attachment,
             max_consecutive_days, allows_half_day, carry_forward_allowed, allow_negative_balance,
             statutory_basis
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          leaveTypeId,
          tenantId,
          type.code,
          type.name,
          type.description,
          type.is_paid ? 1 : 0,
          type.requires_attachment ? 1 : 0,
          type.max_consecutive_days,
          type.allows_half_day ? 1 : 0,
          type.carry_forward_allowed ? 1 : 0,
          type.allow_negative_balance ? 1 : 0,
          type.statutory_basis,
        ),
    );

    if (!type.policy) continue;
    const policyId = `lvp_${ulid()}`;
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO leave_policies (
             policy_id, tenant_id, leave_type_id, name, accrual_method,
             carry_forward_max_days, carry_forward_expiry_months, is_default
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          policyId,
          tenantId,
          leaveTypeId,
          type.policy.name,
          type.policy.accrual_method,
          type.policy.carry_forward_max_days,
          type.policy.carry_forward_expiry_months,
        ),
    );
    for (const band of type.policy.bands) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO leave_policy_bands (
               band_id, tenant_id, policy_id, employment_type,
               min_months_service, max_months_service, entitlement_days
             ) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
          )
          .bind(
            `lvb_${ulid()}`,
            tenantId,
            policyId,
            band.min_months_service,
            band.max_months_service,
            band.entitlement_days,
          ),
      );
    }
  }

  statements.push(
    db
      .prepare(
        `UPDATE leave_settings
         SET defaults_seeded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE tenant_id = ? AND defaults_seeded_at IS NULL`,
      )
      .bind(tenantId),
  );

  await db.batch(statements);
  return true;
}
