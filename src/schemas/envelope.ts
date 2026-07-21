import { z } from "zod";
import { ulid } from "../lib/ulid";
import { currentActor, type Actor } from "../auth/actor-context";

/**
 * The v0 event envelope. Every event on the bus is wrapped in this shape;
 * `payload` is validated separately against the versioned schema registered
 * for its `event_type` (see schemas/events/registry.ts).
 */
export const sourceModuleSchema = z.enum([
  "finance",
  "people",
  "sales",
  "support",
  "build",
  // Communications — inbound/outbound email (Google/Gmail integration).
  "comms",
]);
export type SourceModule = z.infer<typeof sourceModuleSchema>;

export const actorSchema = z.object({
  type: z.enum(["user", "agent", "system"]),
  id: z.string().optional(),
  role: z.string().optional(),
});

export const eventEnvelopeSchema = z.object({
  event_id: z.string().startsWith("evt_"),
  event_type: z
    .string()
    .regex(/^[a-z_]+\.[a-z_]+$/, "event_type must be <entity>.<action>"),
  source_module: sourceModuleSchema,
  tenant_id: z.string().startsWith("biz_"),
  occurred_at: z.string().datetime(),
  payload: z.record(z.unknown()),
  trace_id: z.string().startsWith("trc_"),
  /** Who caused this event (see migration 0011). Omitted when unattributed. */
  actor: actorSchema.optional(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/**
 * Build a well-formed envelope with generated ids and timestamp. The actor is
 * taken from `args.actor` when given (agents/cron pass it explicitly) and
 * otherwise from the ambient request actor context, so HTTP-path emitters get
 * per-user attribution without any signature change.
 */
export function makeEnvelope(args: {
  event_type: string;
  source_module: SourceModule;
  tenant_id: string;
  payload: Record<string, unknown>;
  trace_id?: string;
  occurred_at?: string;
  actor?: Actor;
  /**
   * Override the generated event_id. Pass a value derived from an upstream
   * identity (e.g. a Gmail message id) to make emission idempotent — the
   * consumer's INSERT OR IGNORE dedupes repeats by event_id.
   */
  event_id?: string;
}): EventEnvelope {
  const actor = args.actor ?? currentActor();
  return {
    event_id: args.event_id ?? `evt_${ulid()}`,
    event_type: args.event_type,
    source_module: args.source_module,
    tenant_id: args.tenant_id,
    occurred_at: args.occurred_at ?? new Date().toISOString(),
    payload: args.payload,
    trace_id: args.trace_id ?? `trc_${ulid()}`,
    ...(actor ? { actor } : {}),
  };
}
