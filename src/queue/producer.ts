import type { Env } from "../env";
import type { EventEnvelope } from "../schemas/envelope";

type EventSender = (env: Env, envelope: EventEnvelope) => Promise<void>;

const queueSender: EventSender = async (env, envelope) => {
  await env.EVENTS.send(envelope);
};

let sender: EventSender = queueSender;

/** Test seam: capture emitted events instead of draining the real queue. */
export function setEventSenderForTests(override: EventSender | null): void {
  sender = override ?? queueSender;
}

/** Emit an envelope onto the event bus. */
export async function emitEvent(env: Env, envelope: EventEnvelope): Promise<void> {
  await sender(env, envelope);
}
