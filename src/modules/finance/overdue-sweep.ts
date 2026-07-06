import { makeEnvelope, type EventEnvelope } from "../../schemas/envelope";

/**
 * Daily cron sweep: overdue detection without webhooks.
 *
 * Marks 'sent' invoices whose due date has passed as 'overdue', and emits
 * invoice.overdue for every overdue invoice — including ones marked on a
 * previous run. Re-emission is deliberate: it re-nudges the CollectionsAgent
 * daily while an invoice stays unpaid, and doubles as the safety net for the
 * (deferred) outbox — an event lost between a D1 commit and the queue send is
 * re-emitted on the next sweep. The consumer's INSERT OR IGNORE keeps the
 * events_log deduplicated by event_id; agents must tolerate repeats.
 */
export async function runOverdueSweep(
  env: { DB: D1Database; EVENTS: Queue },
  now: Date = new Date(),
): Promise<{ marked: number; events: EventEnvelope[] }> {
  const today = now.toISOString().slice(0, 10);

  const { results: toMark } = await env.DB.prepare(
    `SELECT tenant_id, invoice_id FROM invoices
     WHERE status = 'sent' AND due_date < ?`,
  )
    .bind(today)
    .all<{ tenant_id: string; invoice_id: string }>();

  if (toMark.length > 0) {
    await env.DB.batch(
      toMark.map((row) =>
        env.DB.prepare(
          "UPDATE invoices SET status = 'overdue', updated_at = ? WHERE tenant_id = ? AND invoice_id = ?",
        ).bind(now.toISOString(), row.tenant_id, row.invoice_id),
      ),
    );
  }

  const { results: overdue } = await env.DB.prepare(
    `SELECT tenant_id, invoice_id, customer_id, amount_due_cents, currency, due_date
     FROM invoices WHERE status = 'overdue'`,
  ).all<{
    tenant_id: string;
    invoice_id: string;
    customer_id: string;
    amount_due_cents: number;
    currency: string;
    due_date: string;
  }>();

  const events: EventEnvelope[] = [];
  for (const invoice of overdue) {
    const daysOverdue = Math.max(
      0,
      Math.floor((now.getTime() - new Date(invoice.due_date).getTime()) / 86_400_000),
    );
    const envelope = makeEnvelope({
      event_type: "invoice.overdue",
      source_module: "finance",
      tenant_id: invoice.tenant_id,
      occurred_at: now.toISOString(),
      payload: {
        invoice_id: invoice.invoice_id,
        customer_id: invoice.customer_id,
        amount_due_cents: invoice.amount_due_cents,
        currency: invoice.currency,
        days_overdue: daysOverdue,
      },
    });
    await env.EVENTS.send(envelope);
    events.push(envelope);
  }

  return { marked: toMark.length, events };
}
