import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { paginate } from "../../gateway/pagination";
import { resolveBaseCurrency } from "../quotes/settings";
import { getEnrichmentProvider } from "../../enrichment";
import {
  getContactRoles,
  listRolesByContact,
  normalizeRoles,
  roleWriteStatements,
} from "./contact-roles";
import type { Env } from "../../env";
import type {
  Activity,
  ActivityKind,
  Contact,
  ContactRole,
  Customer,
  Deal,
  Lead,
  LeadStatus,
  PaymentHistoryEntry,
  PipelineStage,
  PreferredChannel,
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

/**
 * Organization-level fields settable on create/patch. The first block is the
 * quote "To" identity (migration 0013); the second is PRD-003's commercial
 * attributes (migration 0027).
 *
 * PRD-003's `registration_no` and `tax_id` are `reg_no` and `tax_no` here, and
 * its structured billing address is `address_line1..country` — all three
 * shipped in 0013, so 0027 reused them rather than adding synonyms.
 */
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
  industry?: string | null;
  website?: string | null;
  payment_terms_days?: number | null;
  credit_limit_cents?: number | null;
  preferred_channel?: PreferredChannel | null;
  notes?: string | null;
  ship_address_line1?: string | null;
  ship_address_line2?: string | null;
  ship_city?: string | null;
  ship_state?: string | null;
  ship_postcode?: string | null;
  ship_country?: string | null;
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
  // PRD-003 commercial attributes (0027).
  "industry",
  "website",
  "payment_terms_days",
  "credit_limit_cents",
  "preferred_channel",
  "notes",
  "ship_address_line1",
  "ship_address_line2",
  "ship_city",
  "ship_state",
  "ship_postcode",
  "ship_country",
] as const;

const CUSTOMER_COLUMNS = `customer_id, name, email, phone, agent_paused, ${ORG_FIELDS.join(", ")}`;

/**
 * `agent_paused` (PRD-002, 0028) is the per-customer half of the agent kill
 * switch. It is stored as SQLite's 0/1 and read as a boolean — the same
 * treatment `public_holidays.observed` gets. Not in `ORG_FIELDS`: those are all
 * nullable and the create path binds `?? null` for each, which this NOT NULL
 * column would reject.
 */
type CustomerRow = Omit<Customer, "agent_paused"> & { agent_paused: number };

function mapCustomerRow(row: CustomerRow): Customer {
  return { ...row, agent_paused: row.agent_paused === 1 };
}

export async function getCustomer(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<Customer | null> {
  const row = await db
    .prepare(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE tenant_id = ? AND customer_id = ?`,
    )
    .bind(tenantId, customerId)
    .first<CustomerRow>();
  return row ? mapCustomerRow(row) : null;
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
    .all<CustomerRow>();
  const { items, next_cursor } = paginate(results, page.limit, "customer_id");
  return { customers: items.map(mapCustomerRow), next_cursor };
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
  patch: { name?: string; email?: string; phone?: string; agent_paused?: boolean } &
    CustomerOrgFields,
): Promise<Customer> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const field of ["name", "email", "phone", ...ORG_FIELDS] as const) {
    if (patch[field] !== undefined) {
      sets.push(`${field} = ?`);
      binds.push(patch[field]);
    }
  }
  // Pausing the agent on a customer is a CRM edit, not a settings change: it is
  // a property of the relationship, so it lives on the customer page and is
  // held to `crm:write` like the rest of the record.
  if (patch.agent_paused !== undefined) {
    sets.push("agent_paused = ?");
    binds.push(patch.agent_paused ? 1 : 0);
  }
  // Defensive: the route's validator refuses an empty patch, and an empty SET
  // list would be invalid SQL. A no-op patch still has to 404 on a customer
  // that does not exist, so it goes through the same read.
  if (sets.length === 0) {
    const existing = await getCustomer(db, tenantId, customerId);
    if (!existing) throw new CrmError("not_found", "customer not found", 404);
    return existing;
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

function toContact(row: ContactRow, roles: ContactRole[]): Contact {
  return { ...row, is_primary: row.is_primary === 1, roles };
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
  return row ? toContact(row, await getContactRoles(db, tenantId, row.contact_id)) : null;
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
  // One roles query for the whole customer, not one per contact.
  const roles = await listRolesByContact(db, tenantId, customerId);
  return results.map((row) => toContact(row, roles.get(row.contact_id) ?? []));
}

/**
 * No contact.created event on purpose: nothing consumes one today (no agent
 * route, no insights read-model). Add a versioned schema + registry entry the
 * day something wants to react to new contacts.
 *
 * Roles (PRD-003): when the caller states none, the customer's FIRST contact
 * becomes `primary` and every later one `other` — the same rule migration 0027
 * backfilled with, so a migrated tenant and a fresh one behave identically.
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
    roles?: ContactRole[];
  },
): Promise<Contact> {
  const customer = await getCustomer(db, tenantId, input.customer_id);
  if (!customer) throw new CrmError("not_found", `customer ${input.customer_id} not found`, 404);

  const existing = await db
    .prepare("SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ? AND customer_id = ?")
    .bind(tenantId, input.customer_id)
    .first<{ n: number }>();
  const isFirst = (existing?.n ?? 0) === 0;

  const { roles, is_primary } = normalizeRoles({
    roles: input.roles,
    is_primary: input.is_primary,
    fallback: isFirst ? ["primary"] : ["other"],
  });

  const contactId = `contact_${ulid()}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO contacts (contact_id, tenant_id, customer_id, name, title, department, email, phone, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
      ),
    // Inserted with is_primary = 0 and set by the role statements, so the
    // demote-then-promote sequence is the ONLY thing that touches the flag and
    // the partial unique index never sees two primaries.
    ...roleWriteStatements(db, tenantId, {
      customer_id: input.customer_id,
      contact_id: contactId,
      roles: is_primary ? roles : roles.filter((r) => r !== "primary"),
    }),
  ]);
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
    roles?: ContactRole[];
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

  const touchesRoles = patch.roles !== undefined || patch.is_primary !== undefined;

  // Scoped by customer_id too so the nested route can't reach across customers.
  // A patch that ONLY changes roles still needs an existence check, hence the
  // no-op UPDATE below rather than skipping straight to the role statements.
  const scalarUpdate = db
    .prepare(
      sets.length > 0
        ? `UPDATE contacts SET ${sets.join(", ")} WHERE tenant_id = ? AND customer_id = ? AND contact_id = ?`
        : `UPDATE contacts SET name = name WHERE tenant_id = ? AND customer_id = ? AND contact_id = ?`,
    )
    .bind(...binds, tenantId, customerId, contactId);

  if (!touchesRoles) {
    const result = await scalarUpdate.run();
    if (result.meta.changes === 0) {
      throw new CrmError("not_found", "contact not found", 404);
    }
    return (await getContact(db, tenantId, contactId)) as Contact;
  }

  // The role set is only knowable against what the contact holds today, so
  // read before the batch; the write itself is still atomic.
  const current = await getContact(db, tenantId, contactId);
  if (!current || current.customer_id !== customerId) {
    throw new CrmError("not_found", "contact not found", 404);
  }
  const { roles } = normalizeRoles({
    roles: patch.roles,
    is_primary: patch.is_primary,
    fallback: current.roles,
  });

  await db.batch([
    scalarUpdate,
    ...roleWriteStatements(db, tenantId, { customer_id: customerId, contact_id: contactId, roles }),
  ]);
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
