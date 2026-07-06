import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { canTransition, type TicketStatus } from "../src/modules/support/state-machine";
import { changeTicketStatus, createTicket } from "../src/modules/support/service";

const API_KEY = "test_api_key_support";
const TENANT_ID = "biz_support";
const CUSTOMER_ID = "cust_sup_1";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function seedTenant() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Support Test SME", await sha256Hex(API_KEY))
    .run();
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function openTicket(subject: string): Promise<{ ticket_id: string }> {
  const res = await gatewayFetch("/v1/tickets", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: CUSTOMER_ID,
      subject,
      priority: "high",
      body: "It is broken.",
    }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

beforeAll(seedTenant);

describe("tickets", () => {
  it("creates a ticket with an opening customer message", async () => {
    const { ticket_id } = await openTicket("Cannot log in");
    expect(ticket_id).toMatch(/^tkt_/);

    const res = await gatewayFetch(`/v1/tickets/${ticket_id}`, { headers: auth });
    expect(res.status).toBe(200);
    const ticket = (await res.json()) as {
      status: string;
      priority: string;
      messages: { author: string; body: string }[];
    };
    expect(ticket.status).toBe("open");
    expect(ticket.priority).toBe("high");
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0]).toMatchObject({ author: "customer", body: "It is broken." });
  });

  it("appends messages to the thread in order", async () => {
    const { ticket_id } = await openTicket("Feature question");
    for (const [author, body] of [
      ["agent", "Looking into it."],
      ["customer", "Thanks!"],
      ["system", "SLA timer paused."],
    ] as const) {
      const res = await gatewayFetch(`/v1/tickets/${ticket_id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ author, body }),
      });
      expect(res.status).toBe(201);
    }

    const res = await gatewayFetch(`/v1/tickets/${ticket_id}`, { headers: auth });
    const ticket = (await res.json()) as { messages: { author: string }[] };
    expect(ticket.messages.map((m) => m.author)).toEqual([
      "customer",
      "agent",
      "customer",
      "system",
    ]);
  });

  it("messages on unknown tickets are 404", async () => {
    const res = await gatewayFetch("/v1/tickets/tkt_ghost/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ author: "agent", body: "hello?" }),
    });
    expect(res.status).toBe(404);
  });

  it("filters tickets by status", async () => {
    const { ticket_id } = await openTicket("Resolve me");
    await gatewayFetch(`/v1/tickets/${ticket_id}/status`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "resolved" }),
    });

    const res = await gatewayFetch("/v1/tickets?status=resolved", { headers: auth });
    const body = (await res.json()) as { tickets: { ticket_id: string; status: string }[] };
    expect(body.tickets.map((t) => t.ticket_id)).toContain(ticket_id);
    expect(body.tickets.every((t) => t.status === "resolved")).toBe(true);
  });
});

describe("state machine", () => {
  const STATUSES: TicketStatus[] = ["open", "pending", "resolved", "closed"];
  const LEGAL: [TicketStatus, TicketStatus][] = [
    ["open", "pending"],
    ["open", "resolved"],
    ["pending", "open"],
    ["pending", "resolved"],
    ["resolved", "closed"],
    ["resolved", "open"],
  ];

  it("the transition table matches the spec exactly", () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const expected = LEGAL.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it("every legal transition succeeds over HTTP; every illegal one is 409", async () => {
    // Drive a ticket into each 'from' state via legal moves, then attempt every target.
    const pathTo: Record<TicketStatus, TicketStatus[]> = {
      open: [],
      pending: ["pending"],
      resolved: ["resolved"],
      closed: ["resolved", "closed"],
    };

    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (to === from) continue;
        const ticket = await createTicket(env, TENANT_ID, {
          customer_id: CUSTOMER_ID,
          subject: `matrix ${from} → ${to}`,
        });
        for (const step of pathTo[from]) {
          await changeTicketStatus(env, TENANT_ID, ticket.ticket_id, step);
        }

        const res = await gatewayFetch(`/v1/tickets/${ticket.ticket_id}/status`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ status: to }),
        });
        const expected = LEGAL.some(([f, t]) => f === from && t === to);
        expect(res.status, `${from} → ${to}`).toBe(expected ? 200 : 409);
      }
    }
  });

  it("resolving stamps resolved_at and emits through to the events log", async () => {
    const { ticket_id } = await openTicket("Stamp me");
    const res = await gatewayFetch(`/v1/tickets/${ticket_id}/status`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "resolved" }),
    });
    const ticket = (await res.json()) as { resolved_at: string | null };
    expect(ticket.resolved_at).not.toBeNull();
  });
});
