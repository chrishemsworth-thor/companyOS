import { Hono } from "hono";
import { ErpNextAdapter } from "../adapters/erpnext";
import { eventEnvelopeSchema } from "../../schemas/envelope";
import { validatePayload } from "../../schemas/events/registry";
import type { AuthedEnv } from "../middleware/auth";

/**
 * Inbound webhook receivers. Each module's native webhook payload is
 * translated into a normalized event envelope and pushed onto the Queue —
 * step 1→2 of the vertical slice.
 *
 * Auth: the tenant configures its ERPNext webhook with the same
 * `Authorization: Bearer <api_key>` header the gateway already validates, so
 * these routes sit behind apiKeyAuth like everything else.
 */
export const webhooks = new Hono<AuthedEnv>();

webhooks.post("/erpnext", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json({ error: "invalid JSON body" }, 400);

  const adapter = new ErpNextAdapter(c.env.MOCK_MODE === "true");
  const envelope = adapter.normalizeWebhook(tenant.tenant_id, body);
  if (!envelope) {
    // Not an event we track — acknowledge so ERPNext doesn't retry.
    return c.json({ status: "ignored" }, 200);
  }

  // Belt-and-braces: never enqueue an event the consumer would dead-letter.
  const envelopeCheck = eventEnvelopeSchema.safeParse(envelope);
  const payloadCheck = validatePayload(envelope.event_type, envelope.payload);
  if (!envelopeCheck.success || !payloadCheck.ok) {
    return c.json({ error: "normalization produced an invalid event" }, 500);
  }

  await c.env.EVENTS.send(envelope);
  return c.json({ status: "queued", event_id: envelope.event_id, trace_id: envelope.trace_id }, 202);
});
