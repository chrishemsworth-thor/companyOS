/**
 * The shared agent guardrail layer (PRD-002 P0).
 *
 * One guard, one override event, for every agent that sends a message to a
 * person — see SESSION-PLAN conflict C9 for why a second one would be worse
 * than none.
 */
export {
  DEFAULT_AGENT_POLICY,
  DEFAULT_WORK_WEEK,
  AgentSettingsError,
  getAgentSettings,
  isValidTimeZone,
  loadAgentPolicy,
  parseWorkWeek,
  upsertAgentSettings,
  type AgentPolicy,
  type AgentSettingsInput,
  type AgentSettingsView,
} from "./policy";
export {
  applyDecisionGuards,
  preflight,
  referencedIds,
  type DecisionGuardOptions,
  type DecisionGuardResult,
  type EscalationRule,
  type GuardableDecision,
  type GuardrailKind,
  type GuardrailOutcome,
  type GuardrailOverrideRecord,
  type PreflightResult,
  type SendContext,
} from "./guard";
export { contactWindow, NO_HOLIDAYS, type ContactWindow, type HolidayLookup } from "./window";
export { loadHolidayLookup } from "./holidays";
export {
  DEFAULT_TIME_ZONE,
  resolveTimeZone,
  wallToEpoch,
  zoneOffsetMs,
  zoneParts,
  type ZoneParts,
} from "./zone";
