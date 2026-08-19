import { DEFAULT_TIME_ZONE, isValidTimeZone, resolveTimeZone } from "./zone";

/**
 * The tenant-configurable guardrail policy (PRD-002 P0), resolved from D1.
 *
 * "No row => defaults" throughout. The guard runs on the send path inside a
 * Durable Object, so it must have a usable answer for a tenant who has never
 * opened Settings — and the defaults are the safe end of every axis.
 */

export interface AgentPolicy {
  /** PRD-002's `agents.enabled` kill switch. */
  enabled: boolean;
  /** IANA zone name; always valid by the time it reaches the guard. */
  timezone: string;
  /** Contact window in tenant local time, half-open: [start, end). */
  contact_window_start_hour: number;
  contact_window_end_hour: number;
  suppress_weekends: boolean;
  suppress_holidays: boolean;
  max_reminders_per_invoice: number;
  escalation_threshold_days: number;
  contact_cooldown_hours: number;
  max_message_chars: number;
  /**
   * 7 day fractions, index 0 = Sunday; 0 means non-working. Not stored on
   * `agent_settings` — it is read from `leave_settings.work_week`, because
   * "does this company work Saturdays" is one fact with one owner (PRD-006)
   * and a second copy is how two answers start disagreeing.
   */
  work_week: readonly number[];
}

/** Mon–Fri, the same default `leave_settings.work_week` carries. */
export const DEFAULT_WORK_WEEK: readonly number[] = [0, 1, 1, 1, 1, 1, 0];

/**
 * Malaysian SME defaults. `escalation_threshold_days: 60` is the answer to
 * PRD-002's blocking open question: local payment behaviour runs 60–90 days in
 * practice regardless of stated terms, so 30 escalates a customer who is
 * behaving normally for the market, and escalation is the irreversible half of
 * the decision. It is ANDed with ">= 2 prior reminders" in the guard, so
 * lowering it still cannot escalate on first contact.
 */
export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  enabled: true,
  timezone: DEFAULT_TIME_ZONE,
  contact_window_start_hour: 9,
  contact_window_end_hour: 18,
  suppress_weekends: true,
  suppress_holidays: true,
  max_reminders_per_invoice: 5,
  escalation_threshold_days: 60,
  contact_cooldown_hours: 24,
  max_message_chars: 2000,
  work_week: DEFAULT_WORK_WEEK,
};

interface PolicyRow {
  enabled: number | null;
  contact_window_start_hour: number | null;
  contact_window_end_hour: number | null;
  suppress_weekends: number | null;
  suppress_holidays: number | null;
  max_reminders_per_invoice: number | null;
  escalation_threshold_days: number | null;
  contact_cooldown_hours: number | null;
  max_message_chars: number | null;
  timezone: string | null;
  work_week: string | null;
}

/**
 * One row, always — the correlated subqueries mean a tenant with no
 * `agent_settings`, no `company_profile` and no `leave_settings` still gets a
 * row of nulls rather than no row, and every null falls back to the default.
 */
const POLICY_QUERY = `
  SELECT s.enabled, s.contact_window_start_hour, s.contact_window_end_hour,
         s.suppress_weekends, s.suppress_holidays, s.max_reminders_per_invoice,
         s.escalation_threshold_days, s.contact_cooldown_hours, s.max_message_chars,
         (SELECT timezone FROM company_profile WHERE tenant_id = ?) AS timezone,
         (SELECT work_week FROM leave_settings WHERE tenant_id = ?) AS work_week
  FROM (SELECT 1) AS one
  LEFT JOIN agent_settings s ON s.tenant_id = ?`;

/** `leave_settings.work_week` is a JSON array of 7 numbers; anything else is
 * ignored rather than trusted, since a malformed value must not decide whether
 * a customer gets contacted. */
export function parseWorkWeek(raw: string | null | undefined): readonly number[] {
  if (!raw) return DEFAULT_WORK_WEEK;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 7) return DEFAULT_WORK_WEEK;
    if (!parsed.every((n) => typeof n === "number" && Number.isFinite(n))) return DEFAULT_WORK_WEEK;
    return parsed as number[];
  } catch {
    console.warn(`[guardrails] unparseable leave_settings.work_week, using Mon-Fri`);
    return DEFAULT_WORK_WEEK;
  }
}

function fromRow(row: PolicyRow | null): AgentPolicy {
  const d = DEFAULT_AGENT_POLICY;
  const bool = (v: number | null, fallback: boolean) => (v === null ? fallback : v === 1);
  const num = (v: number | null, fallback: number) => (v === null ? fallback : v);
  return {
    enabled: bool(row?.enabled ?? null, d.enabled),
    timezone: resolveTimeZone(row?.timezone),
    contact_window_start_hour: num(row?.contact_window_start_hour ?? null, d.contact_window_start_hour),
    contact_window_end_hour: num(row?.contact_window_end_hour ?? null, d.contact_window_end_hour),
    suppress_weekends: bool(row?.suppress_weekends ?? null, d.suppress_weekends),
    suppress_holidays: bool(row?.suppress_holidays ?? null, d.suppress_holidays),
    max_reminders_per_invoice: num(row?.max_reminders_per_invoice ?? null, d.max_reminders_per_invoice),
    escalation_threshold_days: num(row?.escalation_threshold_days ?? null, d.escalation_threshold_days),
    contact_cooldown_hours: num(row?.contact_cooldown_hours ?? null, d.contact_cooldown_hours),
    max_message_chars: num(row?.max_message_chars ?? null, d.max_message_chars),
    work_week: parseWorkWeek(row?.work_week),
  };
}

/**
 * The guard's entry point. **Never throws.** A failed read (a migration not yet
 * applied on a stale deploy, D1 unavailable mid-request) resolves to
 * `DEFAULT_AGENT_POLICY`, which is conservative on every axis and still lets
 * the agent work. Failing closed here would be a silent stop, which PRD-002
 * rules out; failing open with hardcoded 09:00–18:00 Malaysian defaults is the
 * only option that is both safe and alive.
 */
export async function loadAgentPolicy(db: D1Database, tenantId: string): Promise<AgentPolicy> {
  try {
    const row = await db.prepare(POLICY_QUERY).bind(tenantId, tenantId, tenantId).first<PolicyRow>();
    return fromRow(row);
  } catch (err) {
    console.warn(`[guardrails] policy load failed for ${tenantId}, using defaults: ${String(err)}`);
    return DEFAULT_AGENT_POLICY;
  }
}

/** The settings surface: the resolved policy, plus whether a row exists. */
export interface AgentSettingsView extends AgentPolicy {
  /** False when the tenant has never saved settings and is running defaults. */
  configured: boolean;
}

export async function getAgentSettings(
  db: D1Database,
  tenantId: string,
): Promise<AgentSettingsView> {
  const policy = await loadAgentPolicy(db, tenantId);
  const row = await db
    .prepare("SELECT tenant_id FROM agent_settings WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ tenant_id: string }>();
  return { ...policy, configured: row !== null };
}

export interface AgentSettingsInput {
  enabled?: boolean;
  contact_window_start_hour?: number;
  contact_window_end_hour?: number;
  suppress_weekends?: boolean;
  suppress_holidays?: boolean;
  max_reminders_per_invoice?: number;
  escalation_threshold_days?: number;
  contact_cooldown_hours?: number;
  max_message_chars?: number;
}

const SETTINGS_FIELDS = [
  "enabled",
  "contact_window_start_hour",
  "contact_window_end_hour",
  "suppress_weekends",
  "suppress_holidays",
  "max_reminders_per_invoice",
  "escalation_threshold_days",
  "contact_cooldown_hours",
  "max_message_chars",
] as const;

export class AgentSettingsError extends Error {
  constructor(
    readonly code: "invalid_request",
    message: string,
    readonly httpStatus: 400 = 400,
  ) {
    super(message);
    this.name = "AgentSettingsError";
  }
}

/**
 * Upsert, defaults-preserving: an omitted field keeps whatever the tenant had
 * (or the default, on a first save), so a console form that only knows about
 * some of these cannot silently reset the rest.
 */
export async function upsertAgentSettings(
  db: D1Database,
  tenantId: string,
  input: AgentSettingsInput,
): Promise<AgentSettingsView> {
  const current = await loadAgentPolicy(db, tenantId);
  const merged = { ...current, ...input };
  if (merged.contact_window_end_hour <= merged.contact_window_start_hour) {
    throw new AgentSettingsError(
      "invalid_request",
      "contact_window_end_hour must be greater than contact_window_start_hour",
    );
  }
  const values = SETTINGS_FIELDS.map((f) => {
    const v = merged[f];
    return typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  await db
    .prepare(
      `INSERT INTO agent_settings (tenant_id, ${SETTINGS_FIELDS.join(", ")})
       VALUES (?, ${SETTINGS_FIELDS.map(() => "?").join(", ")})
       ON CONFLICT (tenant_id) DO UPDATE SET
         ${SETTINGS_FIELDS.map((f) => `${f} = excluded.${f}`).join(", ")},
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(tenantId, ...values)
    .run();
  return getAgentSettings(db, tenantId);
}

/** Re-exported so the settings route validates the same way the guard resolves. */
export { isValidTimeZone };
