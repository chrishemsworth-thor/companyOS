import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/** GET /v1/events — tenant-scoped read feed over events_log for the operator UI. */

const API_KEY = "test_api_key_events_a";
const TENANT_A = "biz_events_a";
const OTHER_KEY = "test_api_key_events_b";
const TENANT_B = "biz_events_b";

const auth = { Authorization: `Bearer ${API_KEY}` };

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface FeedResponse {
  items: {
    event_id: string;
    event_type: string;
    source_module: string;
    occurred_at: string;
    trace_id: string;
    payload: Record<string, unknown>;
  }[];
  next_cursor: string | null;
}

async function seedEvent(
  tenantId: string,
  eventId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await env.DB.prepare(
    `INSERT INTO events_log (event_id, event_type, source_module, tenant_id, occurred_at, trace_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(eventId, eventType, "test", tenantId, "2026-07-01T00:00:00Z", "trace_1", JSON.stringify(payload))
    .run();
}

beforeAll(async () => {
  for (const [tenantId, key, name] of [
    [TENANT_A, API_KEY, "Events Tenant A"],
    [TENANT_B, OTHER_KEY, "Events Tenant B"],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
    )
      .bind(tenantId, name, await sha256Hex(key))
      .run();
  }

  // Lexically ascending ids stand in for ULIDs (time-sortable).
  await seedEvent(TENANT_A, "01EVT001", "invoice.overdue", {
    invoice_id: "inv_1",
    customer_id: "cust_1",
  });
  await seedEvent(TENANT_A, "01EVT002", "collections.decision", {
    customer_id: "cust_1",
    risk_score: 55,
    action: "remind",
  });
  await seedEvent(TENANT_A, "01EVT003", "customer.risk_flagged", {
    customer_id: "cust_1",
    risk_score: 80,
    open_invoices: ["inv_1", "inv_2"],
    total_due_cents: 100_000,
  });
  await seedEvent(TENANT_A, "01EVT004", "collections.decision", {
    customer_id: "cust_2",
    risk_score: 10,
    action: "wait",
  });
  await seedEvent(TENANT_B, "01EVT005", "collections.decision", {
    customer_id: "cust_b",
    risk_score: 99,
    action: "escalate",
  });
});

describe("GET /v1/events", () => {
  it("requires auth", async () => {
    expect((await gatewayFetch("/v1/events")).status).toBe(401);
  });

  it("returns only the caller's tenant events, newest first, with parsed payloads", async () => {
    const res = await gatewayFetch("/v1/events", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FeedResponse;
    expect(body.items.map((e) => e.event_id)).toEqual([
      "01EVT004",
      "01EVT003",
      "01EVT002",
      "01EVT001",
    ]);
    expect(body.items.every((e) => e.event_id !== "01EVT005")).toBe(true);
    expect(body.items[1]?.payload.total_due_cents).toBe(100_000);
    expect(body.next_cursor).toBeNull();
  });

  it("filters by comma-separated event types", async () => {
    const res = await gatewayFetch("/v1/events?type=collections.decision,customer.risk_flagged", {
      headers: auth,
    });
    const body = (await res.json()) as FeedResponse;
    expect(body.items.map((e) => e.event_type)).toEqual([
      "collections.decision",
      "customer.risk_flagged",
      "collections.decision",
    ]);
  });

  it("rejects unknown event types", async () => {
    const res = await gatewayFetch("/v1/events?type=not.a.real.event", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("filters by customer_id in the payload", async () => {
    const res = await gatewayFetch("/v1/events?customer_id=cust_2", { headers: auth });
    const body = (await res.json()) as FeedResponse;
    expect(body.items.map((e) => e.event_id)).toEqual(["01EVT004"]);
  });

  it("filters by invoice_id, including open_invoices membership", async () => {
    const res = await gatewayFetch("/v1/events?invoice_id=inv_1", { headers: auth });
    const body = (await res.json()) as FeedResponse;
    expect(body.items.map((e) => e.event_id)).toEqual(["01EVT003", "01EVT001"]);
  });

  it("paginates newest-first with a descending cursor", async () => {
    const first = (await (
      await gatewayFetch("/v1/events?limit=2", { headers: auth })
    ).json()) as FeedResponse;
    expect(first.items.map((e) => e.event_id)).toEqual(["01EVT004", "01EVT003"]);
    expect(first.next_cursor).toBe("01EVT003");

    const second = (await (
      await gatewayFetch(`/v1/events?limit=2&cursor=${first.next_cursor}`, { headers: auth })
    ).json()) as FeedResponse;
    expect(second.items.map((e) => e.event_id)).toEqual(["01EVT002", "01EVT001"]);
    expect(second.next_cursor).toBeNull();
  });
});
