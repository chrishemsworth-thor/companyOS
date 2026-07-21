import type { Env } from "../env";
import { eventEnvelopeSchema, type EventEnvelope } from "../schemas/envelope";
import { validatePayload } from "../schemas/events/registry";
import type { CollectionsAgent } from "../agents/collections";

/**
 * Queue consumer: validate each envelope against the registry, append it to
 * the events_log audit table, and route it to the owning tenant's agent DO.
 * Invalid events are retried by the queue and eventually dead-lettered.
 */
export async function handleEventBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processEvent(env, message.body);
      message.ack();
    } catch (err) {
      console.error(`[consumer] event failed, will retry → DLQ: ${String(err)}`);
      message.retry();
    }
  }
}

/**
 * One event's full processing: validate → audit-log → route to agent. Shared
 * by the queue consumer and the queue-less direct bus (src/queue/direct.ts),
 * so both paths stay behaviorally identical.
 */
export async function processEvent(env: Env, body: unknown): Promise<void> {
  const envelope = parseEnvelope(body);
  await logEvent(env, envelope);
  await routeToAgent(env, envelope);
}

function parseEnvelope(body: unknown): EventEnvelope {
  const envelope = eventEnvelopeSchema.parse(body);
  const payloadCheck = validatePayload(envelope.event_type, envelope.payload);
  if (!payloadCheck.ok) {
    throw new Error(`payload validation failed for ${envelope.event_type}: ${payloadCheck.error}`);
  }
  return envelope;
}

async function logEvent(env: Env, envelope: EventEnvelope): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO events_log
       (event_id, event_type, source_module, tenant_id, occurred_at, trace_id, payload, actor_type, actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      envelope.event_id,
      envelope.event_type,
      envelope.source_module,
      envelope.tenant_id,
      envelope.occurred_at,
      envelope.trace_id,
      JSON.stringify(envelope.payload),
      envelope.actor?.type ?? null,
      envelope.actor?.id ?? null,
    )
    .run();
}

/**
 * Per-event-type routing map. Events not listed here (deal.*, ticket.*,
 * issue.*, ...) are audit-logged only — future agents (SupportAgent, ...)
 * claim their event types by adding entries.
 */
const AGENT_ROUTES: Record<string, "collections"> = {
  "invoice.overdue": "collections",
  "payment.received": "collections",
};

async function routeToAgent(env: Env, envelope: EventEnvelope): Promise<void> {
  if (!AGENT_ROUTES[envelope.event_type]) return;

  // Agent DOs are per (tenant, customer).
  const customerId = (envelope.payload as { customer_id?: string }).customer_id;
  if (!customerId) {
    throw new Error(`event ${envelope.event_id} has no customer_id to route on`);
  }
  const id = env.COLLECTIONS_AGENT.idFromName(`${envelope.tenant_id}:${customerId}`);
  const stub = env.COLLECTIONS_AGENT.get(id) as unknown as CollectionsAgent;
  await stub.onEvent(envelope);
}
