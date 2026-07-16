import { makeEnvelope, type EventEnvelope } from "../../schemas/envelope";

/**
 * Daily cron sweep: expire sent quotes whose expiry date has passed. Mirrors
 * finance/overdue-sweep — mark the rows in one batch, then emit quote.expired
 * for each. Runs alongside the overdue sweep in the Worker's scheduled handler.
 */
export async function runQuoteExpirySweep(
  env: { DB: D1Database; EVENTS: Queue },
  now: Date = new Date(),
): Promise<{ expired: number; events: EventEnvelope[] }> {
  const today = now.toISOString().slice(0, 10);

  const { results: toExpire } = await env.DB.prepare(
    `SELECT tenant_id, quote_id, customer_id FROM quotes
     WHERE status = 'sent' AND expiry_date IS NOT NULL AND expiry_date < ?`,
  )
    .bind(today)
    .all<{ tenant_id: string; quote_id: string; customer_id: string }>();

  if (toExpire.length === 0) return { expired: 0, events: [] };

  await env.DB.batch(
    toExpire.map((row) =>
      env.DB.prepare(
        "UPDATE quotes SET status = 'expired', updated_at = ? WHERE tenant_id = ? AND quote_id = ?",
      ).bind(now.toISOString(), row.tenant_id, row.quote_id),
    ),
  );

  const events: EventEnvelope[] = [];
  for (const row of toExpire) {
    const envelope = makeEnvelope({
      event_type: "quote.expired",
      source_module: "sales",
      tenant_id: row.tenant_id,
      occurred_at: now.toISOString(),
      payload: { quote_id: row.quote_id, customer_id: row.customer_id },
    });
    await env.EVENTS.send(envelope);
    events.push(envelope);
  }

  return { expired: toExpire.length, events };
}
