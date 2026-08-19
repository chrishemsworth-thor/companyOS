import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { makeEnvelope, type EventEnvelope } from "../src/schemas/envelope";
import { validatePayload } from "../src/schemas/events/registry";
import { setLlmProviderFactoryForTests } from "../src/llm";
import { setEventSenderForTests } from "../src/queue/producer";
import { openContactWindow, stubLlmProvider } from "./agent-fixture";
import type { Contact, ContactRole } from "../src/modules/crm/types";

/**
 * PRD-003 (S8) P0 — contact roles and the resolution chain.
 *
 * Every acceptance criterion in the PRD's "Contact roles" block has a test
 * here, named after it. The reminder-addressing criteria go through the real
 * HTTP surface and assert on the `deliveries` audit row rather than on a mock,
 * because "the reminder addresses the billing contact" is a claim about what
 * was actually sent.
 */

const API_KEY = "test_api_key_roles";
const TENANT_ID = "biz_roles";
const OTHER_API_KEY = "test_api_key_roles_other";
const OTHER_TENANT_ID = "biz_roles_other";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const otherAuth = { Authorization: `Bearer ${OTHER_API_KEY}`, "Content-Type": "application/json" };

/**
 * Customers seeded in beforeAll (isolated storage rolls back anything written
 * inside an `it`, so shared fixtures have to live here — the trap SESSION-PLAN
 * records from S1).
 */
const C = {
  /** Has billing + primary contacts, seeded per-test. */
  staffed: "cust_roles_staffed",
  /** Has contacts but none carrying an address. */
  addressless: "cust_roles_addressless",
  /** No contacts, no customer-level email or phone. */
  empty: "cust_roles_empty",
  /** No contacts, but a customer-level email — the pre-PRD-003 shape. */
  legacy: "cust_roles_legacy",
} as const;

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedTenant(tenantId: string, apiKey: string, name: string) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(tenantId, name, await sha256Hex(apiKey))
    .run();
}

async function seedCustomer(
  tenantId: string,
  customerId: string,
  fields: { email?: string | null; phone?: string | null } = {},
) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, email, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      customerId,
      tenantId,
      `Customer ${customerId}`,
      fields.email ?? null,
      fields.phone ?? null,
      new Date().toISOString(),
    )
    .run();
}

beforeAll(async () => {
  await seedTenant(TENANT_ID, API_KEY, "Contact Roles SME");
  await seedTenant(OTHER_TENANT_ID, OTHER_API_KEY, "Other SME");
  await seedCustomer(TENANT_ID, C.staffed, { email: "general@staffed.example" });
  await seedCustomer(TENANT_ID, C.addressless);
  await seedCustomer(TENANT_ID, C.empty);
  await seedCustomer(TENANT_ID, C.legacy, { email: "general@legacy.example" });
  await seedCustomer(OTHER_TENANT_ID, C.staffed, { email: "general@othertenant.example" });
  // Contact-role resolution, not office hours (see test/agent-fixture.ts).
  await openContactWindow(TENANT_ID);
  await openContactWindow(OTHER_TENANT_ID);
});

let capturedEvents: EventEnvelope[];

beforeEach(() => {
  capturedEvents = [];
  setEventSenderForTests(async (_env, envelope) => {
    capturedEvents.push(envelope);
  });
  setLlmProviderFactoryForTests(null);
});

afterEach(() => {
  setEventSenderForTests(null);
  setLlmProviderFactoryForTests(null);
});

function eventsOfType(type: string): EventEnvelope[] {
  return capturedEvents.filter((e) => e.event_type === type);
}

async function addContact(
  customerId: string,
  body: Record<string, unknown>,
  headers = auth,
): Promise<Contact> {
  const res = await gatewayFetch(`/v1/customers/${customerId}/contacts`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Contact;
}

async function listContacts(customerId: string): Promise<Contact[]> {
  const res = await gatewayFetch(`/v1/customers/${customerId}/contacts`, { headers: auth });
  expect(res.status).toBe(200);
  return ((await res.json()) as { contacts: Contact[] }).contacts;
}

async function resolve(customerId: string, role: string, headers = auth) {
  const res = await gatewayFetch(`/v1/customers/${customerId}/contacts/resolve?role=${role}`, {
    headers,
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      contact: Contact | null;
      matched: string | null;
      requested_role?: string;
    },
  };
}

// ---------------------------------------------------------------------------
// Roles on the contact record
// ---------------------------------------------------------------------------

describe("contact roles", () => {
  it("defaults the customer's FIRST contact to primary and later ones to other", async () => {
    const first = await addContact(C.staffed, { name: "Aina", email: "aina@staffed.example" });
    expect(first.roles).toEqual(["primary"]);
    expect(first.is_primary).toBe(true);

    const second = await addContact(C.staffed, { name: "Ravi", email: "ravi@staffed.example" });
    expect(second.roles).toEqual(["other"]);
    expect(second.is_primary).toBe(false);
  });

  it("accepts an explicit multi-valued role set", async () => {
    const contact = await addContact(C.staffed, {
      name: "Wei Ming",
      email: "weiming@staffed.example",
      roles: ["billing", "technical"],
    });
    // Returned in the canonical vocabulary order, not the caller's order.
    expect(contact.roles).toEqual(["billing", "technical"]);
    expect(contact.is_primary).toBe(false);
  });

  it("keeps is_primary and the primary role in step in both directions", async () => {
    // roles: ["primary"] implies the flag...
    const viaRole = await addContact(C.staffed, { name: "Via role", roles: ["primary"] });
    expect(viaRole.is_primary).toBe(true);

    // ...and the flag implies the role, so the pre-roles console keeps working.
    const viaFlag = await addContact(C.staffed, { name: "Via flag", is_primary: true });
    expect(viaFlag.roles).toContain("primary");
    expect(viaFlag.is_primary).toBe(true);
  });

  it("rejects a role outside the vocabulary with 400", async () => {
    const res = await gatewayFetch(`/v1/customers/${C.staffed}/contacts`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Typo", roles: ["biling"] }),
    });
    expect(res.status).toBe(400);
  });

  it("replaces the role set on PATCH and preserves it on an unrelated PATCH", async () => {
    const contact = await addContact(C.staffed, { name: "Shifting", roles: ["technical"] });

    const patched = await gatewayFetch(
      `/v1/customers/${C.staffed}/contacts/${contact.contact_id}`,
      { method: "PATCH", headers: auth, body: JSON.stringify({ roles: ["billing", "signatory"] }) },
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as Contact).roles).toEqual(["billing", "signatory"]);

    const renamed = await gatewayFetch(
      `/v1/customers/${C.staffed}/contacts/${contact.contact_id}`,
      { method: "PATCH", headers: auth, body: JSON.stringify({ title: "Finance Manager" }) },
    );
    const body = (await renamed.json()) as Contact;
    expect(body.title).toBe("Finance Manager");
    expect(body.roles).toEqual(["billing", "signatory"]);
  });

  it("404s a PATCH that names another customer's contact", async () => {
    const contact = await addContact(C.staffed, { name: "Elsewhere", roles: ["billing"] });
    const res = await gatewayFetch(`/v1/customers/${C.empty}/contacts/${contact.contact_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ roles: ["primary"] }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// AC: "Given an attempt to set a second is_primary contact, then the previous
//      primary is cleared atomically (or 409 — pick one and test it)."
//      S8 picked clear-atomically.
// ---------------------------------------------------------------------------

describe("acceptance: a second primary clears the first, atomically", () => {
  it("clears the previous primary's flag AND its primary role", async () => {
    const first = await addContact(C.staffed, { name: "First", roles: ["primary"] });
    const second = await addContact(C.staffed, { name: "Second", roles: ["billing"] });

    const res = await gatewayFetch(`/v1/customers/${C.staffed}/contacts/${second.contact_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ is_primary: true }),
    });
    expect(res.status).toBe(200);
    const promoted = (await res.json()) as Contact;
    expect(promoted.is_primary).toBe(true);
    // The existing roles survive the promotion — it adds `primary`, not replaces.
    expect(promoted.roles).toEqual(["primary", "billing"]);

    const contacts = await listContacts(C.staffed);
    const demoted = contacts.find((c) => c.contact_id === first.contact_id)!;
    expect(demoted.is_primary).toBe(false);
    expect(demoted.roles).not.toContain("primary");
  });

  it("leaves exactly one primary per customer, however many hand-overs happen", async () => {
    const a = await addContact(C.staffed, { name: "A", roles: ["primary"] });
    const b = await addContact(C.staffed, { name: "B", roles: ["primary"] });
    const c = await addContact(C.staffed, { name: "C", roles: ["primary"] });

    const contacts = await listContacts(C.staffed);
    expect(contacts.filter((x) => x.is_primary)).toHaveLength(1);
    expect(contacts.find((x) => x.is_primary)!.contact_id).toBe(c.contact_id);

    // And the join table agrees with the flag — the invariant, checked directly.
    const { results } = await env.DB.prepare(
      `SELECT r.contact_id FROM contact_roles r
         JOIN contacts ct ON ct.tenant_id = r.tenant_id AND ct.contact_id = r.contact_id
        WHERE r.tenant_id = ? AND ct.customer_id = ? AND r.role = 'primary'`,
    )
      .bind(TENANT_ID, C.staffed)
      .all<{ contact_id: string }>();
    expect(results.map((r) => r.contact_id)).toEqual([c.contact_id]);
    expect([a.contact_id, b.contact_id]).not.toContain(results[0]!.contact_id);
  });

  it("does not touch another customer's primary", async () => {
    const mine = await addContact(C.staffed, { name: "Mine", roles: ["primary"] });
    const theirs = await addContact(C.legacy, { name: "Theirs", roles: ["primary"] });

    expect((await listContacts(C.staffed)).find((c) => c.contact_id === mine.contact_id)!.is_primary)
      .toBe(true);
    expect(
      (await listContacts(C.legacy)).find((c) => c.contact_id === theirs.contact_id)!.is_primary,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveContact: requested role -> primary -> any -> null
// ---------------------------------------------------------------------------

describe("resolveContact fallback chain", () => {
  it("matches the requested role when somebody holds it", async () => {
    await addContact(C.staffed, { name: "Aina", roles: ["primary"] });
    const ravi = await addContact(C.staffed, { name: "Ravi", roles: ["billing"] });

    const { body } = await resolve(C.staffed, "billing");
    expect(body.matched).toBe("role");
    expect(body.contact?.contact_id).toBe(ravi.contact_id);
  });

  it("falls back to primary when nobody holds the requested role", async () => {
    const aina = await addContact(C.staffed, { name: "Aina", roles: ["primary"] });
    await addContact(C.staffed, { name: "Wei Ming", roles: ["technical"] });

    const { body } = await resolve(C.staffed, "signatory");
    expect(body.matched).toBe("primary");
    expect(body.contact?.contact_id).toBe(aina.contact_id);
  });

  it("falls back to any contact when there is no primary either", async () => {
    const first = await addContact(C.staffed, { name: "Only", roles: ["primary"] });
    // Demote the sole contact so the customer genuinely has no primary.
    await gatewayFetch(`/v1/customers/${C.staffed}/contacts/${first.contact_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ roles: ["technical"] }),
    });

    const { body } = await resolve(C.staffed, "billing");
    expect(body.matched).toBe("any");
    expect(body.contact?.contact_id).toBe(first.contact_id);
  });

  it("returns contact: null for a customer with no contacts", async () => {
    const { status, body } = await resolve(C.empty, "billing");
    expect(status).toBe(200);
    expect(body.contact).toBeNull();
    expect(body.matched).toBeNull();
  });

  it("400s an unknown role and 404s an unknown customer", async () => {
    expect((await resolve(C.staffed, "chief-vibes")).status).toBe(400);
    expect((await resolve("cust_does_not_exist", "billing")).status).toBe(404);
  });

  it("never resolves across tenants — tenant B gets a 404, not tenant A's contact", async () => {
    await addContact(C.staffed, { name: "Tenant A billing", roles: ["billing"] });
    // Same customer_id string exists for both tenants; B must see only its own.
    const { body } = await resolve(C.staffed, "billing", otherAuth);
    expect(body.contact).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC: "Given a customer with a billing contact, when a reminder is sent, then
//      it addresses the billing contact."
// AC: "Given a customer with no billing contact, then the reminder falls back
//      to primary and the fallback is recorded on the decision."
// ---------------------------------------------------------------------------

async function overdueInvoiceFor(customerId: string): Promise<string> {
  const res = await gatewayFetch("/v1/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: customerId,
      currency: "MYR",
      due_date: "2026-01-15",
      lines: [{ description: "Consulting", quantity: 1, unit_cents: 250_000 }],
    }),
  });
  expect(res.status).toBe(201);
  const { invoice_id } = (await res.json()) as { invoice_id: string };
  await gatewayFetch(`/v1/invoices/${invoice_id}/send`, { method: "POST", headers: auth });
  await env.DB.prepare(
    "UPDATE invoices SET status = 'overdue' WHERE tenant_id = ? AND invoice_id = ?",
  )
    .bind(TENANT_ID, invoice_id)
    .run();
  return invoice_id;
}

async function lastDelivery(invoiceId: string) {
  return env.DB.prepare(
    "SELECT to_address, contact_id, channel, status FROM deliveries WHERE tenant_id = ? AND invoice_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(TENANT_ID, invoiceId)
    .first<{ to_address: string; contact_id: string | null; channel: string; status: string }>();
}

describe("acceptance: a reminder addresses the billing contact", () => {
  it("sends to the billing contact, not the customer's general address", async () => {
    await addContact(C.staffed, { name: "Aina", email: "aina@staffed.example", roles: ["primary"] });
    const ravi = await addContact(C.staffed, {
      name: "Ravi",
      email: "ravi@staffed.example",
      roles: ["billing"],
    });

    const invoiceId = await overdueInvoiceFor(C.staffed);
    const res = await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "email" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { contact_id: string; contact_match: string };
    expect(body.contact_id).toBe(ravi.contact_id);
    expect(body.contact_match).toBe("role");

    const row = await lastDelivery(invoiceId);
    expect(row).toMatchObject({
      to_address: "ravi@staffed.example",
      contact_id: ravi.contact_id,
      status: "sent",
    });
  });

  it("falls back to the primary contact and reports the fallback", async () => {
    const aina = await addContact(C.staffed, {
      name: "Aina",
      email: "aina@staffed.example",
      roles: ["primary"],
    });

    const invoiceId = await overdueInvoiceFor(C.staffed);
    const res = await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "email" }),
    });
    const body = (await res.json()) as { contact_id: string; contact_match: string };
    expect(body.contact_id).toBe(aina.contact_id);
    expect(body.contact_match).toBe("primary");
    expect((await lastDelivery(invoiceId))!.to_address).toBe("aina@staffed.example");
  });

  it("still reaches the customer-level address when there are no contacts at all", async () => {
    // The pre-PRD-003 shape. Dropping this rung would turn a working reminder
    // into a silent non-send the moment roles shipped.
    const invoiceId = await overdueInvoiceFor(C.legacy);
    const res = await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "email" }),
    });
    expect(res.status).toBe(202);
    const row = await lastDelivery(invoiceId);
    expect(row!.to_address).toBe("general@legacy.example");
    expect(row!.contact_id).toBeNull();
  });

  it("records the resolved contact and the fallback on collections.decision", async () => {
    const aina = await addContact(C.staffed, {
      name: "Aina",
      email: "aina@staffed.example",
      roles: ["primary"],
    });
    const invoiceId = await overdueInvoiceFor(C.staffed);

    const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${C.staffed}`);
    const stub = env.COLLECTIONS_AGENT.get(id) as unknown as { onEvent(e: unknown): Promise<void> };
    await stub.onEvent(
      makeEnvelope({
        event_type: "invoice.overdue",
        source_module: "finance",
        tenant_id: TENANT_ID,
        payload: {
          invoice_id: invoiceId,
          customer_id: C.staffed,
          amount_due_cents: 250_000,
          currency: "MYR",
          days_overdue: 40,
        },
      }),
    );

    const [decision] = eventsOfType("collections.decision");
    expect(decision).toBeDefined();
    const payload = decision!.payload as { contact_id: string; contact_match: string };
    expect(payload.contact_id).toBe(aina.contact_id);
    expect(payload.contact_match).toBe("primary");
    // The additive fields keep the registered v1 schema valid — no v2 needed.
    expect(validatePayload("collections.decision", decision!.payload)).toEqual({ ok: true });
  });

  it("names the recipient in the LLM prompt, and flags a fallback as a guess", async () => {
    await addContact(C.staffed, {
      name: "Ravi Kumar",
      title: "Finance Manager",
      email: "ravi@staffed.example",
      roles: ["billing"],
    });
    const invoiceId = await overdueInvoiceFor(C.staffed);

    const llmMock = vi.fn().mockResolvedValue({
      risk_score: 50,
      action: "remind",
      channel: "email",
      message: "Hi Ravi, a gentle nudge about the open invoice.",
    });
    stubLlmProvider(llmMock);

    const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${C.staffed}`);
    const stub = env.COLLECTIONS_AGENT.get(id) as unknown as { onEvent(e: unknown): Promise<void> };
    await stub.onEvent(
      makeEnvelope({
        event_type: "invoice.overdue",
        source_module: "finance",
        tenant_id: TENANT_ID,
        payload: {
          invoice_id: invoiceId,
          customer_id: C.staffed,
          amount_due_cents: 250_000,
          currency: "MYR",
          days_overdue: 40,
        },
      }),
    );

    const [req] = llmMock.mock.calls[0] as [{ prompt: string }];
    expect(req.prompt).toContain("Ravi Kumar, Finance Manager");
    expect(req.prompt).toContain("designated billing contact");
    expect(req.prompt).not.toContain("resolved by fallback");
  });
});

// ---------------------------------------------------------------------------
// AC: "Given a customer with zero contacts, then reminder dispatch fails
//      gracefully with a customer.no_contact event rather than throwing."
// ---------------------------------------------------------------------------

describe("acceptance: dispatch with nobody to address", () => {
  it("emits customer.no_contact and answers 422 rather than a false success", async () => {
    const invoiceId = await overdueInvoiceFor(C.empty);
    const res = await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "email" }),
    });

    // Graceful means no unhandled exception and an observable event. It does
    // NOT mean a 2xx for a send that never happened — see the dispatch comment.
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("no_recipient");

    const [event] = eventsOfType("customer.no_contact");
    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({
      customer_id: C.empty,
      invoice_id: invoiceId,
      channel_requested: "email",
      reason: "no_contacts",
    });
    expect(event!.source_module).toBe("finance");
  });

  it("distinguishes contacts-with-no-address from no-contacts-at-all", async () => {
    await addContact(C.addressless, { name: "Nameless", roles: ["billing"] });
    const invoiceId = await overdueInvoiceFor(C.addressless);
    await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "email" }),
    });

    const [event] = eventsOfType("customer.no_contact");
    expect((event!.payload as { reason: string }).reason).toBe("no_address");
  });

  it("is a registered event type the consumer will accept", async () => {
    const invoiceId = await overdueInvoiceFor(C.empty);
    await gatewayFetch(`/v1/invoices/${invoiceId}/reminder`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "whatsapp" }),
    });
    const [event] = eventsOfType("customer.no_contact");
    expect(validatePayload("customer.no_contact", event!.payload)).toEqual({ ok: true });
    expect((event!.payload as { channel_requested: string }).channel_requested).toBe("whatsapp");
  });

  it("leaves the CollectionsAgent tracking rather than crashing it", async () => {
    const invoiceId = await overdueInvoiceFor(C.empty);
    const id = env.COLLECTIONS_AGENT.idFromName(`${TENANT_ID}:${C.empty}`);
    const stub = env.COLLECTIONS_AGENT.get(id) as unknown as {
      onEvent(e: unknown): Promise<void>;
      snapshot(): Promise<{ last_contact: string | null } | null>;
    };

    await expect(
      stub.onEvent(
        makeEnvelope({
          event_type: "invoice.overdue",
          source_module: "finance",
          tenant_id: TENANT_ID,
          payload: {
            invoice_id: invoiceId,
            customer_id: C.empty,
            amount_due_cents: 250_000,
            currency: "MYR",
            days_overdue: 40,
          },
        }),
      ),
    ).resolves.toBeUndefined();

    // Undeliverable must not record a contact that never happened.
    expect((await stub.snapshot())!.last_contact).toBeNull();
    expect(eventsOfType("customer.no_contact")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation on the roles surface itself
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("does not list another tenant's contacts for the same customer id", async () => {
    await addContact(C.staffed, { name: "Tenant A person", roles: ["billing"] });
    const res = await gatewayFetch(`/v1/customers/${C.staffed}/contacts`, { headers: otherAuth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { contacts: Contact[] }).contacts).toEqual([]);
  });

  it("does not leak roles across tenants when both hold the same role", async () => {
    await addContact(C.staffed, { name: "A billing", email: "a@a.example", roles: ["billing"] });
    await addContact(C.staffed, { name: "B billing", email: "b@b.example", roles: ["billing"] }, otherAuth);

    const a = await resolve(C.staffed, "billing");
    const b = await resolve(C.staffed, "billing", otherAuth);
    expect(a.body.contact?.name).toBe("A billing");
    expect(b.body.contact?.name).toBe("B billing");
  });
});

// ---------------------------------------------------------------------------
// The role vocabulary is closed in code, since SQL does not close it
// ---------------------------------------------------------------------------

describe("role vocabulary", () => {
  it("accepts every documented role and nothing else", async () => {
    const all: ContactRole[] = ["primary", "billing", "technical", "signatory", "other"];
    const contact = await addContact(C.staffed, { name: "Everything", roles: all });
    expect(contact.roles).toEqual(all);
  });
});
