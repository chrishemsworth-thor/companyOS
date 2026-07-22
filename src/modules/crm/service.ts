import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { paginate } from "../../gateway/pagination";
import { resolveBaseCurrency } from "../quotes/settings";
import { getEnrichmentProvider } from "../../enrichment";
import type { Env } from "../../env";
import type {
  Activity,
  ActivityKind,
  Contact,
  Customer,
  Deal,
  Lead,
  LeadStatus,
  PaymentHistoryEntry,
  PipelineStage,
} from "./types";

/**
 * Native CRM service (source_module: 'sales'). Same pattern as finance:
 * D1 writes first, then event emission; the consumer's INSERT OR IGNORE
 * dedupes at-least-once delivery.
 */

export class CrmError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_stage" | "invalid_status",
    message: string,
    readonly httpStatus: 404 | 409 | 422 = 422,
  ) {
    super(message);
    this.name = "CrmError";
  }
}

/** Default pipeline, seeded per tenant on first use (idempotent via UNIQUE (tenant_id, name)). */
export const DEFAULT_STAGES = [
  { name: "Lead", sort_order: 1, is_won: 0, is_lost: 0 },
  { name: "Qualified", sort_order: 2, is_won: 0, is_lost: 0 },
  { name: "Proposal", sort_order: 3, is_won: 0, is_lost: 0 },
  { name: "Won", sort_order: 4, is_won: 1, is_lost: 0 },
  { name: "Lost", sort_order: 5, is_won: 0, is_lost: 1 },
] as const;

export async function ensureDefaultStages(db: D1Database, tenantId: string): Promise<void> {
  await db.batch(
    DEFAULT_STAGES.map((s) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO pipeline_stages (stage_id, tenant_id, name, sort_order, is_won, is_lost)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(`stg_${ulid()}`, tenantId, s.name, s.sort_order, s.is_won, s.is_lost),
    ),
  );
}

interface StageRow {
  stage_id: string;
  name: string;
  sort_order: number;
  is_won: number;
  is_lost: number;
}

function toStage(row: StageRow): PipelineStage {
  return { ...row, is_won: row.is_won === 1, is_lost: row.is_lost === 1 };
}

export async function listStages(db: D1Database, tenantId: string): Promise<PipelineStage[]> {
  const { results } = await db
    .prepare(
      `SELECT stage_id, name, sort_order, is_won, is_lost FROM pipeline_stages
       WHERE tenant_id = ? ORDER BY sort_order`,
    )
    .bind(tenantId)
    .all<StageRow>();
  return results.map(toStage);
}

async function getStage(
  db: D1Database,
  tenantId: string,
  stageId: string,
): Promise<PipelineStage | null> {
  const row = await db
    .prepare(
      "SELECT stage_id, name, sort_order, is_won, is_lost FROM pipeline_stages WHERE tenant_id = ? AND stage_id = ?",
    )
    .bind(tenantId, stageId)
    .first<StageRow>();
  return row ? toStage(row) : null;
}

// ---- Customers ----

/** Organization-level fields settable on create/patch (migration 0013). */
export interface CustomerOrgFields {
  legal_name?: string | null;
  reg_no?: string | null;
  tax_no?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
  country?: string | null;
}

const ORG_FIELDS = [
  "legal_name",
  "reg_no",
  "tax_no",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postcode",
  "country",
] as const;

const CUSTOMER_COLUMNS = `customer_id, name, email, phone, ${ORG_FIELDS.join(", ")}`;

export async function getCustomer(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<Customer | null> {
  return db
    .prepare(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE tenant_id = ? AND customer_id = ?`,
    )
    .bind(tenantId, customerId)
    .first<Customer>();
}

export async function listCustomers(
  db: D1Database,
  tenantId: string,
  page: { cursor?: string; limit: number },
): Promise<{ customers: Customer[]; next_cursor: string | null }> {
  const clauses = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (page.cursor) {
    clauses.push("customer_id > ?");
    binds.push(page.cursor);
  }
  binds.push(page.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE ${clauses.join(" AND ")}
       ORDER BY customer_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<Customer>();
  const { items, next_cursor } = paginate(results, page.limit, "customer_id");
  return { customers: items, next_cursor };
}

export async function createCustomer(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: { name: string; email?: string; phone?: string } & CustomerOrgFields,
): Promise<Customer> {
  const customerId = `cust_${ulid()}`;
  const orgBinds = ORG_FIELDS.map((f) => input[f] ?? null);
  await env.DB.prepare(
    `INSERT INTO customers (customer_id, tenant_id, name, email, phone, created_at, ${ORG_FIELDS.join(", ")})
     VALUES (?, ?, ?, ?, ?, ?, ${ORG_FIELDS.map(() => "?").join(", ")})`,
  )
    .bind(
      customerId,
      tenantId,
      input.name,
      input.email ?? null,
      input.phone ?? null,
      new Date().toISOString(),
      ...orgBinds,
    )
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "customer.created",
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        customer_id: customerId,
        name: input.name,
        ...(input.email ? { email: input.email } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
      },
    }),
  );

  return (await getCustomer(env.DB, tenantId, customerId)) as Customer;
}

export async function updateCustomer(
  db: D1Database,
  tenantId: string,
  customerId: string,
  patch: { name?: string; email?: string; phone?: string } & CustomerOrgFields,
): Promise<Customer> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const field of ["name", "email", "phone", ...ORG_FIELDS] as const) {
    if (patch[field] !== undefined) {
      sets.push(`${field} = ?`);
      binds.push(patch[field]);
    }
  }
  const result = await db
    .prepare(`UPDATE customers SET ${sets.join(", ")} WHERE tenant_id = ? AND customer_id = ?`)
    .bind(...binds, tenantId, customerId)
    .run();
  if (result.meta.changes === 0) {
    throw new CrmError("not_found", "customer not found", 404);
  }
  return (await getCustomer(db, tenantId, customerId)) as Customer;
}

// ---- Contacts ----

interface ContactRow {
  contact_id: string;
  customer_id: string;
  name: string;
  title: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  is_primary: number;
  created_at: string;
}

const CONTACT_COLUMNS =
  "contact_id, customer_id, name, title, department, email, phone, is_primary, created_at";

function toContact(row: ContactRow): Contact {
  return { ...row, is_primary: row.is_primary === 1 };
}

export async function getContact(
  db: D1Database,
  tenantId: string,
  contactId: string,
): Promise<Contact | null> {
  const row = await db
    .prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE tenant_id = ? AND contact_id = ?`)
    .bind(tenantId, contactId)
    .first<ContactRow>();
  return row ? toContact(row) : null;
}

export async function listContacts(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<Contact[]> {
  const { results } = await db
    .prepare(
      `SELECT ${CONTACT_COLUMNS} FROM contacts
       WHERE tenant_id = ? AND customer_id = ? ORDER BY is_primary DESC, created_at`,
    )
    .bind(tenantId, customerId)
    .all<ContactRow>();
  return results.map(toContact);
}

/**
 * No contact.created event on purpose: nothing consumes one today (no agent
 * route, no insights read-model). Add a versioned schema + registry entry the
 * day something wants to react to new contacts.
 */
export async function createContact(
  db: D1Database,
  tenantId: string,
  input: {
    customer_id: string;
    name: string;
    title?: string;
    department?: string;
    email?: string;
    phone?: string;
    is_primary?: boolean;
  },
): Promise<Contact> {
  const customer = await getCustomer(db, tenantId, input.customer_id);
  if (!customer) throw new CrmError("not_found", `customer ${input.customer_id} not found`, 404);

  const contactId = `contact_${ulid()}`;
  await db
    .prepare(
      `INSERT INTO contacts (contact_id, tenant_id, customer_id, name, title, department, email, phone, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      contactId,
      tenantId,
      input.customer_id,
      input.name,
      input.title ?? null,
      input.department ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.is_primary ? 1 : 0,
    )
    .run();
  return (await getContact(db, tenantId, contactId)) as Contact;
}

export async function updateContact(
  db: D1Database,
  tenantId: string,
  customerId: string,
  contactId: string,
  patch: {
    name?: string;
    title?: string | null;
    department?: string | null;
    email?: string | null;
    phone?: string | null;
    is_primary?: boolean;
  },
): Promise<Contact> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const field of ["name", "title", "department", "email", "phone"] as const) {
    if (patch[field] !== undefined) {
      sets.push(`${field} = ?`);
      binds.push(patch[field]);
    }
  }
  if (patch.is_primary !== undefined) {
    sets.push("is_primary = ?");
    binds.push(patch.is_primary ? 1 : 0);
  }
  // Scoped by customer_id too so the nested route can't reach across customers.
  const result = await db
    .prepare(
      `UPDATE contacts SET ${sets.join(", ")} WHERE tenant_id = ? AND customer_id = ? AND contact_id = ?`,
    )
    .bind(...binds, tenantId, customerId, contactId)
    .run();
  if (result.meta.changes === 0) {
    throw new CrmError("not_found", "contact not found", 404);
  }
  return (await getContact(db, tenantId, contactId)) as Contact;
}

/** Real query over payments/applications — replaces the old Frappe call. */
export async function getPaymentHistory(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<PaymentHistoryEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT p.payment_id, pa.invoice_id, pa.applied_cents, p.currency, p.received_at
       FROM payments p
       JOIN payment_applications pa
         ON pa.tenant_id = p.tenant_id AND pa.payment_id = p.payment_id
       WHERE p.tenant_id = ? AND p.customer_id = ?
       ORDER BY p.received_at`,
    )
    .bind(tenantId, customerId)
    .all<PaymentHistoryEntry>();
  return results;
}

// ---- Deals ----

const DEAL_COLUMNS =
  "deal_id, customer_id, title, value_cents, currency, stage_id, status, created_at, updated_at";

export async function getDeal(
  db: D1Database,
  tenantId: string,
  dealId: string,
): Promise<Deal | null> {
  return db
    .prepare(`SELECT ${DEAL_COLUMNS} FROM deals WHERE tenant_id = ? AND deal_id = ?`)
    .bind(tenantId, dealId)
    .first<Deal>();
}

export async function listDeals(
  db: D1Database,
  tenantId: string,
  filter: { status?: Deal["status"]; cursor?: string; limit: number },
): Promise<{ deals: Deal[]; next_cursor: string | null }> {
  const clauses = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (filter.status) {
    clauses.push("status = ?");
    binds.push(filter.status);
  }
  if (filter.cursor) {
    clauses.push("deal_id > ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT ${DEAL_COLUMNS} FROM deals WHERE ${clauses.join(" AND ")}
       ORDER BY deal_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<Deal>();
  const { items, next_cursor } = paginate(results, filter.limit, "deal_id");
  return { deals: items, next_cursor };
}

export async function createDeal(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: {
    customer_id: string;
    title: string;
    value_cents: number;
    /** ISO 4217; omitted => the company's base currency. */
    currency?: string;
    stage_id?: string;
  },
): Promise<Deal> {
  const customer = await getCustomer(env.DB, tenantId, input.customer_id);
  if (!customer) throw new CrmError("not_found", `customer ${input.customer_id} not found`, 404);

  // Deals stay multi-currency; the company base currency is only the default
  // when the caller omits currency (same rule as invoices and quotes).
  const currency = input.currency ?? (await resolveBaseCurrency(env.DB, tenantId));

  await ensureDefaultStages(env.DB, tenantId);
  let stage: PipelineStage | null;
  if (input.stage_id) {
    stage = await getStage(env.DB, tenantId, input.stage_id);
    if (!stage) throw new CrmError("invalid_stage", `stage ${input.stage_id} not found`);
  } else {
    stage = (await listStages(env.DB, tenantId))[0]!;
  }

  const dealId = `deal_${ulid()}`;
  await env.DB.prepare(
    `INSERT INTO deals (deal_id, tenant_id, customer_id, title, value_cents, currency, stage_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(dealId, tenantId, input.customer_id, input.title, input.value_cents, currency, stage.stage_id)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "deal.created",
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        deal_id: dealId,
        customer_id: input.customer_id,
        title: input.title,
        value_cents: input.value_cents,
        currency,
        stage_id: stage.stage_id,
      },
    }),
  );

  return (await getDeal(env.DB, tenantId, dealId))!;
}

/**
 * Move a deal between stages. Landing on a winning/losing stage settles the
 * deal's status and emits deal.won / deal.lost on top of deal.stage_changed.
 */
export async function changeDealStage(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  dealId: string,
  toStageId: string,
): Promise<Deal> {
  const deal = await getDeal(env.DB, tenantId, dealId);
  if (!deal) throw new CrmError("not_found", "deal not found", 404);
  const stage = await getStage(env.DB, tenantId, toStageId);
  if (!stage) throw new CrmError("invalid_stage", `stage ${toStageId} not found`);

  const status: Deal["status"] = stage.is_won ? "won" : stage.is_lost ? "lost" : "open";
  await env.DB.prepare(
    "UPDATE deals SET stage_id = ?, status = ?, updated_at = ? WHERE tenant_id = ? AND deal_id = ?",
  )
    .bind(stage.stage_id, status, new Date().toISOString(), tenantId, dealId)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "deal.stage_changed",
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        deal_id: dealId,
        customer_id: deal.customer_id,
        from_stage: deal.stage_id,
        to_stage: stage.stage_id,
      },
    }),
  );
  if (status !== "open") {
    await env.EVENTS.send(
      makeEnvelope({
        event_type: status === "won" ? "deal.won" : "deal.lost",
        source_module: "sales",
        tenant_id: tenantId,
        payload: {
          deal_id: dealId,
          customer_id: deal.customer_id,
          value_cents: deal.value_cents,
          currency: deal.currency,
        },
      }),
    );
  }

  return (await getDeal(env.DB, tenantId, dealId))!;
}

// ---- Leads (Sales Phase A — see docs/architecture/sales-module-design.md) ----

const LEAD_COLUMNS =
  "lead_id, name, company, email, phone, title, source, status, notes, enriched_at, converted_customer_id, converted_deal_id, created_at, updated_at";

export async function getLead(db: D1Database, tenantId: string, leadId: string): Promise<Lead | null> {
  return db
    .prepare(`SELECT ${LEAD_COLUMNS} FROM leads WHERE tenant_id = ? AND lead_id = ?`)
    .bind(tenantId, leadId)
    .first<Lead>();
}

export async function listLeads(
  db: D1Database,
  tenantId: string,
  filter: { status?: LeadStatus; cursor?: string; limit: number },
): Promise<{ leads: Lead[]; next_cursor: string | null }> {
  const clauses = ["tenant_id = ?"];
  const binds: unknown[] = [tenantId];
  if (filter.status) {
    clauses.push("status = ?");
    binds.push(filter.status);
  }
  if (filter.cursor) {
    clauses.push("lead_id > ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT ${LEAD_COLUMNS} FROM leads WHERE ${clauses.join(" AND ")}
       ORDER BY lead_id ASC LIMIT ?`,
    )
    .bind(...binds)
    .all<Lead>();
  const { items, next_cursor } = paginate(results, filter.limit, "lead_id");
  return { leads: items, next_cursor };
}

export async function createLead(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: {
    name: string;
    company?: string;
    email?: string;
    phone?: string;
    title?: string;
    source?: string;
    notes?: string;
  },
): Promise<Lead> {
  const leadId = `lead_${ulid()}`;
  await env.DB.prepare(
    `INSERT INTO leads (lead_id, tenant_id, name, company, email, phone, title, source, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      leadId,
      tenantId,
      input.name,
      input.company ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.title ?? null,
      input.source ?? "manual",
      input.notes ?? null,
    )
    .run();

  const lead = (await getLead(env.DB, tenantId, leadId)) as Lead;
  await env.EVENTS.send(
    makeEnvelope({
      event_type: "lead.created",
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        lead_id: leadId,
        name: input.name,
        ...(input.company ? { company: input.company } : {}),
        ...(input.email ? { email: input.email } : {}),
        source: lead.source,
        status: lead.status,
      },
    }),
  );
  return lead;
}

export async function updateLead(
  db: D1Database,
  tenantId: string,
  leadId: string,
  patch: {
    name?: string;
    company?: string | null;
    email?: string | null;
    phone?: string | null;
    title?: string | null;
    source?: string;
    notes?: string | null;
    status?: LeadStatus;
  },
): Promise<Lead> {
  const lead = await getLead(db, tenantId, leadId);
  if (!lead) throw new CrmError("not_found", "lead not found", 404);
  if (lead.status === "converted") {
    throw new CrmError("invalid_status", "converted lead is immutable", 409);
  }
  if (patch.status === "converted") {
    throw new CrmError("invalid_status", "status 'converted' is set by /convert, not PATCH");
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const field of ["name", "company", "email", "phone", "title", "source", "notes", "status"] as const) {
    if (patch[field] !== undefined) {
      sets.push(`${field} = ?`);
      binds.push(patch[field]);
    }
  }
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  await db
    .prepare(`UPDATE leads SET ${sets.join(", ")} WHERE tenant_id = ? AND lead_id = ?`)
    .bind(...binds, tenantId, leadId)
    .run();
  return (await getLead(db, tenantId, leadId)) as Lead;
}

/**
 * Convert a lead into a customer (+ contact when the lead named a company,
 * + deal when the caller asked for one), then freeze the lead. Sub-creates
 * emit their own events (customer.created, deal.created); the lead row is
 * updated last, so a mid-sequence failure leaves the lead unconverted and
 * the operation retryable — same at-least-once posture as the event bus.
 */
export async function convertLead(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  leadId: string,
  input: {
    deal?: { title: string; value_cents: number; currency?: string; stage_id?: string };
  } = {},
): Promise<{ lead: Lead; customer: Customer; contact: Contact | null; deal: Deal | null }> {
  const lead = await getLead(env.DB, tenantId, leadId);
  if (!lead) throw new CrmError("not_found", "lead not found", 404);
  if (lead.status !== "new" && lead.status !== "qualified") {
    throw new CrmError("invalid_status", `cannot convert a ${lead.status} lead`, 409);
  }

  // The customer row is the ORGANIZATION (quotes "To" block convention);
  // a lead without a company converts as a person-customer.
  const customer = await createCustomer(env, tenantId, {
    name: lead.company ?? lead.name,
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
  });

  let contact: Contact | null = null;
  if (lead.company) {
    contact = await createContact(env.DB, tenantId, {
      customer_id: customer.customer_id,
      name: lead.name,
      title: lead.title ?? undefined,
      email: lead.email ?? undefined,
      phone: lead.phone ?? undefined,
      is_primary: true,
    });
  }

  const deal = input.deal ? await createDeal(env, tenantId, { customer_id: customer.customer_id, ...input.deal }) : null;

  await env.DB.prepare(
    `UPDATE leads SET status = 'converted', converted_customer_id = ?, converted_deal_id = ?, updated_at = ?
     WHERE tenant_id = ? AND lead_id = ?`,
  )
    .bind(customer.customer_id, deal?.deal_id ?? null, new Date().toISOString(), tenantId, leadId)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "lead.converted",
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        lead_id: leadId,
        customer_id: customer.customer_id,
        ...(contact ? { contact_id: contact.contact_id } : {}),
        ...(deal ? { deal_id: deal.deal_id } : {}),
      },
    }),
  );

  return { lead: (await getLead(env.DB, tenantId, leadId)) as Lead, customer, contact, deal };
}

/** Fields the enrichment port may fill (never overwriting a non-empty value). */
const ENRICHABLE_FIELDS = ["company", "email", "phone", "title", "notes"] as const;

export async function enrichLead(
  env: Env,
  tenantId: string,
  leadId: string,
): Promise<{ lead: Lead; enriched_fields: string[] }> {
  const lead = await getLead(env.DB, tenantId, leadId);
  if (!lead) throw new CrmError("not_found", "lead not found", 404);
  if (lead.status === "converted") {
    throw new CrmError("invalid_status", "converted lead is immutable", 409);
  }

  const provider = getEnrichmentProvider(env);
  const found = await provider.enrichLead({
    name: lead.name,
    company: lead.company,
    email: lead.email,
    phone: lead.phone,
    title: lead.title,
  });

  const sets: string[] = [];
  const binds: unknown[] = [];
  const enrichedFields: string[] = [];
  for (const field of ENRICHABLE_FIELDS) {
    const value = found[field];
    if (value && !lead[field]) {
      sets.push(`${field} = ?`);
      binds.push(value);
      enrichedFields.push(field);
    }
  }
  if (enrichedFields.length === 0) {
    return { lead, enriched_fields: [] };
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE leads SET ${sets.join(", ")}, enriched_at = ?, updated_at = ? WHERE tenant_id = ? AND lead_id = ?`,
  )
    .bind(...binds, now, now, tenantId, leadId)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "lead.enriched",
      source_module: "sales",
      tenant_id: tenantId,
      payload: { lead_id: leadId, provider: provider.name, enriched_fields: enrichedFields },
    }),
  );

  return { lead: (await getLead(env.DB, tenantId, leadId)) as Lead, enriched_fields: enrichedFields };
}

// ---- Activities ----

/** Plain row insert, no event — used by agents (e.g. reminder_sent) where the bus event already exists. */
export async function insertActivityRow(
  db: D1Database,
  tenantId: string,
  input: {
    customer_id: string;
    deal_id?: string;
    kind: ActivityKind;
    body?: string;
    occurred_at?: string;
  },
): Promise<Activity> {
  const activity: Activity = {
    activity_id: `act_${ulid()}`,
    customer_id: input.customer_id,
    deal_id: input.deal_id ?? null,
    kind: input.kind,
    body: input.body ?? null,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO activities (activity_id, tenant_id, customer_id, deal_id, kind, body, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      activity.activity_id,
      tenantId,
      activity.customer_id,
      activity.deal_id,
      activity.kind,
      activity.body,
      activity.occurred_at,
    )
    .run();
  return activity;
}

export async function logActivity(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: {
    customer_id: string;
    deal_id?: string;
    kind: ActivityKind;
    body?: string;
    occurred_at?: string;
  },
): Promise<Activity> {
  const activity = await insertActivityRow(env.DB, tenantId, input);
  await env.EVENTS.send(
    makeEnvelope({
      event_type: "activity.logged",
      source_module: "sales",
      tenant_id: tenantId,
      payload: {
        activity_id: activity.activity_id,
        customer_id: activity.customer_id,
        ...(activity.deal_id ? { deal_id: activity.deal_id } : {}),
        kind: activity.kind,
        occurred_at: activity.occurred_at,
      },
    }),
  );
  return activity;
}

export async function listActivities(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<Activity[]> {
  const { results } = await db
    .prepare(
      `SELECT activity_id, customer_id, deal_id, kind, body, occurred_at FROM activities
       WHERE tenant_id = ? AND customer_id = ? ORDER BY occurred_at`,
    )
    .bind(tenantId, customerId)
    .all<Activity>();
  return results;
}
