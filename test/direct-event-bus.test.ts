import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { ensureEventBus } from "../src/queue/direct";
import { makeEnvelope } from "../src/schemas/envelope";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * Queue-less (free-plan) event dispatch — docs/queue-send.md. The direct bus
 * substitutes for the EVENTS queue binding when it is absent and runs the
 * consumer pipeline (validate → audit-log → route to agent) inline.
 */

const TENANT_ID = "biz_directbus";
const CUSTOMER_ID = "cust_direct_1";

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Direct Bus SME", await sha256Hex("test_api_key_directbus"))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(CUSTOMER_ID, TENANT_ID, "Queue-less Sdn Bhd", "ql@example.com", new Date().toISOString())
    .run();
});

/** The env a free-plan deploy sees: everything except the EVENTS binding. */
function bareEnv(): Env {
  const clone = { ...(env as unknown as Env) };
  delete (clone as { EVENTS?: Queue }).EVENTS;
  return clone;
}

async function eventLogRow(eventId: string) {
  return env.DB.prepare("SELECT event_id, event_type, tenant_id FROM events_log WHERE event_id = ?")
    .bind(eventId)
    .first<{ event_id: string; event_type: string; tenant_id: string }>();
}

describe("ensureEventBus", () => {
  it("passes a queue-bound env through untouched", () => {
    const bound = env as unknown as Env;
    expect(ensureEventBus(bound)).toBe(bound);
  });

  it("substitutes the direct bus when the EVENTS binding is absent, without mutating the input", () => {
    const bare = bareEnv();
    const wrapped = ensureEventBus(bare);
    expect(wrapped).not.toBe(bare);
    expect((bare as { EVENTS?: Queue }).EVENTS).toBeUndefined();
    expect(typeof wrapped.EVENTS.send).toBe("function");
    expect(typeof wrapped.EVENTS.sendBatch).toBe("function");
  });
});

describe("direct event bus", () => {
  it("audit-logs a valid event inline on send()", async () => {
    const bus = ensureEventBus(bareEnv()).EVENTS;
    const envelope = makeEnvelope({
      event_type: "invoice.created",
      source_module: "finance",
      tenant_id: TENANT_ID,
      payload: {
        invoice_id: "inv_direct_created",
        customer_id: CUSTOMER_ID,
        total_cents: 50_000,
        currency: "MYR",
        due_date: "2026-08-01",
      },
    });

    await bus.send(envelope);

    const row = await eventLogRow(envelope.event_id);
    expect(row).toMatchObject({
      event_id: envelope.event_id,
      event_type: "invoice.created",
      tenant_id: TENANT_ID,
    });
  });

  it("routes collection events to the agent Durable Object inline", async () => {
    const bus = ensureEventBus(bareEnv()).EVENTS;
    const envelope = makeEnvelope({
      event_type: "invoice.overdue",
      source_module: "finance",
      tenant_id: TENANT_ID,
      payload: {
        invoice_id: "inv_direct_overdue",
        customer_id: CUSTOMER_ID,
        amount_due_cents: 120_000,
        currency: "MYR",
        days_overdue: 3,
      },
    });

    await bus.send(envelope);

    const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${CUSTOMER_ID}`);
    const stub = env.COLLECTIONS_AGENT.get(id) as unknown as {
      snapshot(): Promise<{ open_overdue_invoices: string[] } | null>;
    };
    const state = await stub.snapshot();
    expect(state?.open_overdue_invoices).toContain("inv_direct_overdue");
  });

  it("delivers every message in a sendBatch()", async () => {
    const bus = ensureEventBus(bareEnv()).EVENTS;
    const envelopes = ["inv_batch_a", "inv_batch_b"].map((invoiceId) =>
      makeEnvelope({
        event_type: "invoice.created",
        source_module: "finance",
        tenant_id: TENANT_ID,
        payload: {
          invoice_id: invoiceId,
          customer_id: CUSTOMER_ID,
          total_cents: 10_000,
          currency: "MYR",
          due_date: "2026-08-01",
        },
      }),
    );

    await bus.sendBatch(envelopes.map((body) => ({ body })));

    for (const envelope of envelopes) {
      expect(await eventLogRow(envelope.event_id)).not.toBeNull();
    }
  });

  it("swallows processing failures instead of failing the emitting request", async () => {
    const bus = ensureEventBus(bareEnv()).EVENTS;

    // Not an envelope at all: envelope validation fails, send() still resolves.
    await expect(bus.send({ not: "an envelope" })).resolves.toBeDefined();

    // Well-formed envelope with an unregistered event_type: payload validation
    // fails, so it is dropped without reaching the audit log.
    const unknown = makeEnvelope({
      event_type: "bogus.event",
      source_module: "finance",
      tenant_id: TENANT_ID,
      payload: {},
    });
    await expect(bus.send(unknown)).resolves.toBeDefined();
    expect(await eventLogRow(unknown.event_id)).toBeNull();
  });
});
