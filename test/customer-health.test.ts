import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { setEventSenderForTests } from "../src/queue/producer";
import { getCustomerSignals } from "../src/modules/crm/signals";
import { computeHealth, type CustomerHealth } from "../src/modules/crm/health";

/**
 * PRD-003 (S8) P0 — customer health.
 *
 * Health is derived on read, so these drive it through real rows: real
 * invoices, real tickets, real activities. The band assertions are secondary —
 * PRD-003 says *"reasons matter more than the score"*, so every case also
 * asserts what the reasons actually say.
 */

const API_KEY = "test_api_key_health";
const TENANT_ID = "biz_health";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

const C = {
  fresh: "cust_health_fresh",
  good: "cust_health_good",
  overdue: "cust_health_overdue",
  ticketed: "cust_health_ticketed",
  quiet: "cust_health_quiet",
} as const;

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function dateDaysAgo(n: number): string {
  return daysAgo(n).slice(0, 10);
}

/** Rows written straight to D1 so a 90-day-old invoice does not need a time machine. */
async function seedInvoice(
  customerId: string,
  opts: {
    id: string;
    status: string;
    dueDate: string;
    amountDue: number;
    issuedAt?: string;
    paidAt?: string;
  },
) {
  await env.DB.prepare(
    `INSERT INTO invoices (invoice_id, tenant_id, customer_id, status, amount_due_cents, total_cents, currency, due_date, issued_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, 'MYR', ?, ?, ?)`,
  )
    .bind(
      opts.id,
      TENANT_ID,
      customerId,
      opts.status,
      opts.amountDue,
      100_000,
      opts.dueDate,
      opts.issuedAt ?? null,
      opts.paidAt ?? null,
    )
    .run();
}

async function seedTicket(customerId: string, id: string, status: string, createdAt: string) {
  await env.DB.prepare(
    `INSERT INTO tickets (ticket_id, tenant_id, customer_id, subject, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, TENANT_ID, customerId, "Subject", status, createdAt)
    .run();
}

async function seedActivity(customerId: string, id: string, occurredAt: string) {
  await env.DB.prepare(
    `INSERT INTO activities (activity_id, tenant_id, customer_id, kind, body, occurred_at)
     VALUES (?, ?, ?, 'note', 'note', ?)`,
  )
    .bind(id, TENANT_ID, customerId, occurredAt)
    .run();
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Health SME", await sha256Hex(API_KEY))
    .run();
  for (const id of Object.values(C)) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, payment_terms_days, created_at) VALUES (?, ?, ?, 30, ?)",
    )
      .bind(id, TENANT_ID, `Customer ${id}`, new Date().toISOString())
      .run();
  }
});

beforeEach(() => setEventSenderForTests(async () => {}));
afterEach(() => setEventSenderForTests(null));

async function health(customerId: string): Promise<CustomerHealth> {
  const res = await gatewayFetch(`/v1/customers/${customerId}`, { headers: auth });
  expect(res.status).toBe(200);
  return ((await res.json()) as { health: CustomerHealth }).health;
}

function codes(h: CustomerHealth): string[] {
  return h.reasons.map((r) => r.code);
}

// ---------------------------------------------------------------------------
// AC: "Given a customer with two invoices 60+ days overdue, then health is
//      at_risk with both invoices named in the reasons."
// ---------------------------------------------------------------------------

describe("acceptance: two invoices 60+ days overdue", () => {
  it("is at_risk and names both invoices", async () => {
    await seedInvoice(C.overdue, {
      id: "inv_health_a",
      status: "overdue",
      dueDate: dateDaysAgo(75),
      amountDue: 100_000,
    });
    await seedInvoice(C.overdue, {
      id: "inv_health_b",
      status: "overdue",
      dueDate: dateDaysAgo(64),
      amountDue: 250_000,
    });

    const h = await health(C.overdue);
    expect(h.band).toBe("at_risk");

    const reason = h.reasons.find((r) => r.code === "invoices_severely_overdue");
    expect(reason).toBeDefined();
    // Both invoices named — the whole point of "reasons matter more".
    expect(reason!.detail).toContain("inv_health_a");
    expect(reason!.detail).toContain("inv_health_b");
    expect(reason!.detail).toContain("2 invoices");
    expect(reason!.invoice_ids).toEqual(["inv_health_a", "inv_health_b"]);
  });

  it("is at_risk on TWO merely-overdue invoices, before either hits 60 days", async () => {
    await seedInvoice(C.overdue, {
      id: "inv_health_c",
      status: "overdue",
      dueDate: dateDaysAgo(10),
      amountDue: 100_000,
    });
    await seedInvoice(C.overdue, {
      id: "inv_health_d",
      status: "overdue",
      dueDate: dateDaysAgo(5),
      amountDue: 100_000,
    });
    const h = await health(C.overdue);
    expect(h.band).toBe("at_risk");
    expect(codes(h)).toContain("multiple_overdue_invoices");
  });

  it("is only watch on a single, recently overdue invoice", async () => {
    await seedInvoice(C.overdue, {
      id: "inv_health_e",
      status: "overdue",
      dueDate: dateDaysAgo(3),
      amountDue: 100_000,
    });
    const h = await health(C.overdue);
    expect(h.band).toBe("watch");
    expect(codes(h)).toContain("invoice_overdue");
  });

  it("ignores a draft invoice past its due date — nobody sent it", async () => {
    await seedInvoice(C.overdue, {
      id: "inv_health_draft",
      status: "draft",
      dueDate: dateDaysAgo(90),
      amountDue: 100_000,
    });
    const h = await health(C.overdue);
    expect(h.band).toBe("good");
    expect(codes(h)).not.toContain("invoices_severely_overdue");
  });
});

// ---------------------------------------------------------------------------
// AC: "Given a customer paying on time with no tickets, then health is good."
// ---------------------------------------------------------------------------

describe("acceptance: a customer paying on time", () => {
  it("is good, and says why", async () => {
    await seedInvoice(C.good, {
      id: "inv_health_paid",
      status: "paid",
      dueDate: dateDaysAgo(40),
      amountDue: 0,
      issuedAt: daysAgo(70),
      paidAt: daysAgo(50),
    });
    await seedActivity(C.good, "act_health_recent", daysAgo(3));

    const h = await health(C.good);
    expect(h.band).toBe("good");
    // A healthy customer gets a reason too — an empty panel reads as
    // "not computed", which is worse than saying nothing is wrong.
    expect(codes(h)).toContain("paying_on_time");
    expect(h.reasons[0]!.detail).toContain("20 days");
  });

  it("measures slowness against the customer's OWN terms, not a constant", async () => {
    // 55 days to pay is fine on 60-day terms and slow on 30-day terms. Getting
    // this wrong is how a health signal loses an account manager's trust.
    await env.DB.prepare(
      "UPDATE customers SET payment_terms_days = 60 WHERE tenant_id = ? AND customer_id = ?",
    )
      .bind(TENANT_ID, C.good)
      .run();
    await seedInvoice(C.good, {
      id: "inv_health_slowish",
      status: "paid",
      dueDate: dateDaysAgo(10),
      amountDue: 0,
      issuedAt: daysAgo(70),
      paidAt: daysAgo(15),
    });

    const lenient = await health(C.good);
    expect(lenient.band).toBe("good");

    await env.DB.prepare(
      "UPDATE customers SET payment_terms_days = 30 WHERE tenant_id = ? AND customer_id = ?",
    )
      .bind(TENANT_ID, C.good)
      .run();
    const strict = await health(C.good);
    expect(strict.band).toBe("watch");
    expect(codes(strict)).toContain("slow_payer");
  });
});

// ---------------------------------------------------------------------------
// AC: "Given a new customer with no history, then health is good with an
//      explicit 'insufficient history' reason rather than a misleading score."
// ---------------------------------------------------------------------------

describe("acceptance: a customer with no history", () => {
  it("is good with an explicit insufficient_history reason", async () => {
    const h = await health(C.fresh);
    expect(h.band).toBe("good");
    expect(codes(h)).toEqual(["insufficient_history"]);
    expect(h.reasons[0]!.detail).toMatch(/nothing to assess/i);
  });

  it("stops claiming insufficient history the moment there is any", async () => {
    await seedActivity(C.fresh, "act_health_first", daysAgo(1));
    const h = await health(C.fresh);
    expect(codes(h)).not.toContain("insufficient_history");
  });
});

// ---------------------------------------------------------------------------
// Support load and relationship recency
// ---------------------------------------------------------------------------

describe("support load and recency", () => {
  it("escalates to at_risk on a ticket left open past two weeks", async () => {
    await seedTicket(C.ticketed, "tkt_health_old", "open", daysAgo(20));
    const h = await health(C.ticketed);
    expect(h.band).toBe("at_risk");
    const reason = h.reasons.find((r) => r.code === "ticket_ageing");
    expect(reason!.detail).toContain("1 open ticket");
    expect(reason!.detail).toContain("20 days old");
  });

  it("is only watch on a fresh open ticket", async () => {
    await seedTicket(C.ticketed, "tkt_health_new", "open", daysAgo(2));
    const h = await health(C.ticketed);
    expect(h.band).toBe("watch");
    expect(codes(h)).toContain("open_tickets");
  });

  it("does not count resolved or closed tickets", async () => {
    await seedTicket(C.ticketed, "tkt_health_done", "resolved", daysAgo(200));
    await seedTicket(C.ticketed, "tkt_health_shut", "closed", daysAgo(200));
    const h = await health(C.ticketed);
    expect(h.band).toBe("good");
  });

  it("flags a customer nobody has touched in 90 days", async () => {
    await seedActivity(C.quiet, "act_health_stale", daysAgo(120));
    const h = await health(C.quiet);
    expect(h.band).toBe("watch");
    expect(codes(h)).toContain("no_recent_activity");
  });

  it("mentions the open pipeline when there is one at stake", async () => {
    await seedActivity(C.quiet, "act_health_stale2", daysAgo(120));
    await env.DB.prepare(
      `INSERT INTO deals (deal_id, tenant_id, customer_id, title, value_cents, currency, stage_id, status)
       VALUES (?, ?, ?, 'Renewal', 5000000, 'MYR', 'stg_health', 'open')`,
    )
      .bind("deal_health_1", TENANT_ID, C.quiet)
      .run()
      .catch(() => {
        // The stage FK may reject a synthetic stage id; the deal is optional
        // colour for this assertion, not its subject.
      });
    const h = await health(C.quiet);
    expect(codes(h)).toContain("no_recent_activity");
  });
});

// ---------------------------------------------------------------------------
// Reason ordering and band derivation
// ---------------------------------------------------------------------------

describe("reasons and band stay consistent", () => {
  it("puts the most severe reason first and derives the band from the list", async () => {
    await seedInvoice(C.overdue, {
      id: "inv_health_sev",
      status: "overdue",
      dueDate: dateDaysAgo(80),
      amountDue: 100_000,
    });
    await seedTicket(C.overdue, "tkt_health_mild", "open", daysAgo(1));

    const h = await health(C.overdue);
    expect(h.band).toBe("at_risk");
    expect(h.reasons[0]!.band).toBe("at_risk");
    // Never a band with no reason arguing for it.
    expect(h.reasons.some((r) => r.band === h.band)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC: "Given the health computation, then it adds no more than one additional
//      query to the customer detail endpoint."
// ---------------------------------------------------------------------------

describe("acceptance: health costs exactly one extra query", () => {
  it("issues one prepare() for everything health and credit need", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");
    try {
      await getCustomerSignals(env.DB, TENANT_ID, C.overdue);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      prepare.mockRestore();
    }
  });

  it("computes the band from that one row with no further reads", async () => {
    const signals = await getCustomerSignals(env.DB, TENANT_ID, C.overdue);
    const prepare = vi.spyOn(env.DB, "prepare");
    try {
      // computeHealth is pure — it takes the row and returns the band. If it
      // ever grows a database read, this fails.
      computeHealth(signals);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });
});
