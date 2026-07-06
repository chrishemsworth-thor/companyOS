import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

const API_KEY = "test_api_key_crm";
const TENANT_ID = "biz_crm";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function seedTenant() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "CRM Test SME", await sha256Hex(API_KEY))
    .run();
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createCustomer(name: string): Promise<{ customer_id: string }> {
  const res = await gatewayFetch("/v1/customers", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, email: "c@example.com" }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function getStages(): Promise<
  { stage_id: string; name: string; is_won: boolean; is_lost: boolean }[]
> {
  const res = await gatewayFetch("/v1/deals/stages", { headers: auth });
  expect(res.status).toBe(200);
  return ((await res.json()) as { stages: never[] }).stages;
}

beforeAll(seedTenant);

describe("customers", () => {
  it("creates and reads back a customer", async () => {
    const { customer_id } = await createCustomer("Acme Sdn Bhd");
    expect(customer_id).toMatch(/^cust_/);

    const res = await gatewayFetch(`/v1/customers/${customer_id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("Acme Sdn Bhd");

    const list = await gatewayFetch("/v1/customers", { headers: auth });
    const body = (await list.json()) as { customers: { customer_id: string }[] };
    expect(body.customers.map((c) => c.customer_id)).toContain(customer_id);
  });

  it("payment history is a native query over payments/applications", async () => {
    const { customer_id } = await createCustomer("Paying Customer");

    const invoiceRes = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id,
        currency: "MYR",
        due_date: "2026-08-01",
        lines: [{ description: "Services", quantity: 1, unit_cents: 25_000 }],
      }),
    });
    const { invoice_id } = (await invoiceRes.json()) as { invoice_id: string };
    await gatewayFetch(`/v1/invoices/${invoice_id}/send`, { method: "POST", headers: auth });
    await gatewayFetch("/v1/payments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id,
        amount_cents: 25_000,
        currency: "MYR",
        applications: [{ invoice_id, applied_cents: 25_000 }],
      }),
    });

    const history = await gatewayFetch(`/v1/customers/${customer_id}/payment-history`, {
      headers: auth,
    });
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      payments: { invoice_id: string; applied_cents: number }[];
    };
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({ invoice_id, applied_cents: 25_000 });
  });
});

describe("deals", () => {
  it("seeds the default pipeline once", async () => {
    const stages = await getStages();
    expect(stages.map((s) => s.name)).toEqual(["Lead", "Qualified", "Proposal", "Won", "Lost"]);
    expect(await getStages()).toHaveLength(5); // idempotent
  });

  it("creates a deal in the first stage by default", async () => {
    const { customer_id } = await createCustomer("Deal Customer");
    const res = await gatewayFetch("/v1/deals", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id,
        title: "Annual contract",
        value_cents: 1_200_000,
        currency: "MYR",
      }),
    });
    expect(res.status).toBe(201);
    const deal = (await res.json()) as { deal_id: string; stage_id: string; status: string };
    expect(deal.status).toBe("open");
    const stages = await getStages();
    expect(deal.stage_id).toBe(stages[0]!.stage_id);
  });

  it("rejects deals for unknown customers with 404", async () => {
    const res = await gatewayFetch("/v1/deals", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: "cust_ghost",
        title: "Phantom",
        value_cents: 100,
        currency: "MYR",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("stage change to Won settles the deal; unknown stage is 422", async () => {
    const { customer_id } = await createCustomer("Winner");
    const create = await gatewayFetch("/v1/deals", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ customer_id, title: "Big win", value_cents: 500_000, currency: "MYR" }),
    });
    const { deal_id } = (await create.json()) as { deal_id: string };
    const stages = await getStages();
    const won = stages.find((s) => s.is_won)!;

    const move = await gatewayFetch(`/v1/deals/${deal_id}/stage`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ stage_id: won.stage_id }),
    });
    expect(move.status).toBe(200);
    const deal = (await move.json()) as { status: string; stage_id: string };
    expect(deal.status).toBe("won");
    expect(deal.stage_id).toBe(won.stage_id);

    const bad = await gatewayFetch(`/v1/deals/${deal_id}/stage`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ stage_id: "stg_nonexistent" }),
    });
    expect(bad.status).toBe(422);
  });

  it("filters deals by status", async () => {
    const { customer_id } = await createCustomer("Filter Customer");
    const create = await gatewayFetch("/v1/deals", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ customer_id, title: "Filtered", value_cents: 100, currency: "MYR" }),
    });
    const { deal_id } = (await create.json()) as { deal_id: string };
    const won = (await getStages()).find((s) => s.is_won)!;
    await gatewayFetch(`/v1/deals/${deal_id}/stage`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ stage_id: won.stage_id }),
    });

    const res = await gatewayFetch("/v1/deals?status=won", { headers: auth });
    const body = (await res.json()) as { deals: { deal_id: string; status: string }[] };
    expect(body.deals.map((d) => d.deal_id)).toContain(deal_id);
    expect(body.deals.every((d) => d.status === "won")).toBe(true);
  });
});

describe("activities", () => {
  it("logs an activity and lists it per customer", async () => {
    const { customer_id } = await createCustomer("Chatty Customer");
    const res = await gatewayFetch("/v1/activities", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ customer_id, kind: "call", body: "Discussed renewal" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { activity_id: string }).activity_id).toMatch(/^act_/);

    const list = await gatewayFetch(`/v1/customers/${customer_id}/activities`, { headers: auth });
    const body = (await list.json()) as { activities: { kind: string; body: string }[] };
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0]!.kind).toBe("call");
  });

  it("the CollectionsAgent's reminders appear as reminder_sent activities", async () => {
    const { customer_id } = await createCustomer("Late Payer");

    // Phase 2: the agent assembles its context from D1, so the overdue
    // invoice must actually exist there.
    const invoiceRes = await gatewayFetch("/v1/invoices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id,
        currency: "MYR",
        due_date: "2026-06-26",
        lines: [{ description: "Late work", quantity: 1, unit_cents: 90_000 }],
      }),
    });
    const { invoice_id } = (await invoiceRes.json()) as { invoice_id: string };
    await gatewayFetch(`/v1/invoices/${invoice_id}/send`, { method: "POST", headers: auth });
    await env.DB.prepare(
      "UPDATE invoices SET status = 'overdue' WHERE tenant_id = ? AND invoice_id = ?",
    )
      .bind(TENANT_ID, invoice_id)
      .run();

    const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${customer_id}`);
    const stub = env.COLLECTIONS_AGENT.get(id) as unknown as {
      onEvent(e: unknown): Promise<void>;
    };
    const { makeEnvelope } = await import("../src/schemas/envelope");
    await stub.onEvent(
      makeEnvelope({
        event_type: "invoice.overdue",
        source_module: "finance",
        tenant_id: TENANT_ID,
        payload: {
          invoice_id,
          customer_id,
          amount_due_cents: 90_000,
          currency: "MYR",
          days_overdue: 3,
        },
      }),
    );

    const list = await gatewayFetch(`/v1/customers/${customer_id}/activities`, { headers: auth });
    const body = (await list.json()) as { activities: { kind: string }[] };
    expect(body.activities.some((a) => a.kind === "reminder_sent")).toBe(true);
  });
});
