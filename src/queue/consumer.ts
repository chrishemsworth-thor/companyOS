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
      const envelope = parseEnvelope(message.body);
      await logEvent(env, envelope);
      await routeToAgent(env, envelope);
      message.ack();
    } catch (err) {
      console.error(`[consumer] event failed, will retry → DLQ: ${String(err)}`);
      message.retry();
    }
  }
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
       (event_id, event_type, source_module, tenant_id, occurred_at, trace_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      envelope.event_id,
      envelope.event_type,
      envelope.source_module,
      envelope.tenant_id,
      envelope.occurred_at,
      envelope.trace_id,
      JSON.stringify(envelope.payload),
    )
    .run();
}

async function routeToAgent(env: Env, envelope: EventEnvelope): Promise<void> {
  // Finance events carry customer_id; the agent DO is per (tenant, customer).
  const customerId = (envelope.payload as { customer_id?: string }).customer_id;
  if (!customerId) {
    throw new Error(`event ${envelope.event_id} has no customer_id to route on`);
  }
  const id = env.COLLECTIONS_AGENT.idFromName(`${envelope.tenant_id}:${customerId}`);
  const stub = env.COLLECTIONS_AGENT.get(id) as unknown as CollectionsAgent;
  await stub.onEvent(envelope);
}
