import type { Env } from "../env";
import { processEvent } from "./consumer";

/**
 * Queue-less event bus for deployments without Cloudflare Queues (the one
 * paid-only dependency — see docs/queue-send.md). Implements the `Queue`
 * producer interface, so the ~40 `env.EVENTS.send(...)` call sites across the
 * modules work unchanged; each send runs the same validate → audit-log →
 * route-to-agent pipeline the queue consumer runs, just inline.
 *
 * Trade-off vs a real queue: no retries and no dead-letter queue. A failed
 * event is logged and dropped — the business write that emitted it has
 * already committed, and the daily cron sweep re-emits `invoice.overdue`
 * for anything still unpaid, so collections self-heals on the next cycle.
 */
export function createDirectEventBus(env: Env): Queue {
  const deliver = async (body: unknown): Promise<void> => {
    try {
      await processEvent(env, body);
    } catch (err) {
      console.error(`[direct-bus] event processing failed (no queue, not retried): ${String(err)}`);
    }
  };
  // Processing is inline, so the "queue" is always drained by the time send()
  // resolves — report an empty backlog.
  const emptyBacklog = () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  const bus: Pick<Queue, "send" | "sendBatch"> = {
    async send(message: unknown): Promise<QueueSendResponse> {
      await deliver(message);
      return emptyBacklog();
    },
    async sendBatch(messages: Iterable<MessageSendRequest<unknown>>): Promise<QueueSendBatchResponse> {
      for (const message of messages) await deliver(message.body);
      return emptyBacklog();
    },
  };
  return bus as Queue;
}

/**
 * Normalize the environment at a Worker entry point: when the EVENTS queue
 * binding exists (paid plan, wrangler.jsonc) it is used as-is; when absent
 * (free plan, wrangler.free.jsonc) events dispatch inline through the direct
 * bus. Returns a shallow copy rather than mutating `env`, which the runtime
 * shares across invocations.
 */
export function ensureEventBus(env: Env): Env {
  if ((env as { EVENTS?: Queue }).EVENTS) return env;
  const wrapped: Env = { ...env };
  wrapped.EVENTS = createDirectEventBus(wrapped);
  return wrapped;
}
