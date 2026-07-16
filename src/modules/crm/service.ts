import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { paginate } from "../../gateway/pagination";
import type {
  Activity,
  ActivityKind,
  Contact,
  Customer,
  Deal,
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
    readonly code: "not_found" | "invalid_stage",
    message: string,
    readonly httpStatus: 404 | 422 = 422,
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
    currency: string;
    stage_id?: string;
  },
): Promise<Deal> {
  const customer = await getCustomer(env.DB, tenantId, input.customer_id);
  if (!customer) throw new CrmError("not_found", `customer ${input.customer_id} not found`, 404);

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
    .bind(dealId, tenantId, input.customer_id, input.title, input.value_cents, input.currency, stage.stage_id)
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
        currency: input.currency,
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
