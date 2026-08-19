import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { pageQuerySchema } from "../pagination";
import { crmErrorResponse } from "./deals";
import {
  createContact,
  createCustomer,
  getCustomer,
  getPaymentHistory,
  listActivities,
  listContacts,
  listCustomers,
  updateContact,
  updateCustomer,
} from "../../modules/crm/service";
import {
  CONTACT_ROLES,
  contactRoleSchema,
  resolveContact,
} from "../../modules/crm/contact-roles";
import { getAllCustomerSignals, getCustomerSignals } from "../../modules/crm/signals";
import { computeHealth } from "../../modules/crm/health";
import type { CollectionsAgent } from "../../agents/collections";

// Organization-level fields on a customer (migration 0013), used by the quote
// "To" block. All optional so the simple {name,email,phone} flow is unchanged.
const orgFieldsSchema = {
  legal_name: z.string().max(200).nullish(),
  // PRD-003 calls these `registration_no` (SSM) and `tax_id` (SST); they
  // shipped in 0013 under these names and the quote "To" block already renders
  // them, so S8 reused them rather than adding synonyms.
  reg_no: z.string().max(80).nullish(),
  tax_no: z.string().max(80).nullish(),
  // Billing address (PRD-003's "structured billing address").
  address_line1: z.string().max(200).nullish(),
  address_line2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(),
  state: z.string().max(100).nullish(),
  postcode: z.string().max(20).nullish(),
  country: z.string().max(80).nullish(),
  // Commercial attributes (PRD-003, migration 0027).
  industry: z.string().max(120).nullish(),
  website: z.string().max(300).nullish(),
  /** null means "use the tenant default"; 0 means "due on issue". */
  payment_terms_days: z.number().int().min(0).max(365).nullish(),
  credit_limit_cents: z.number().int().min(0).nullish(),
  preferred_channel: z.enum(["email", "whatsapp"]).nullish(),
  notes: z.string().max(10_000).nullish(),
  ship_address_line1: z.string().max(200).nullish(),
  ship_address_line2: z.string().max(200).nullish(),
  ship_city: z.string().max(100).nullish(),
  ship_state: z.string().max(100).nullish(),
  ship_postcode: z.string().max(20).nullish(),
  ship_country: z.string().max(80).nullish(),
};

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  ...orgFieldsSchema,
});

const patchBodySchema = createBodySchema
  .extend({
    /**
     * PRD-002's per-customer agent kill switch (migration 0028). Patch-only:
     * a customer is never created paused, and the flag is an operational
     * decision about an existing relationship. Checked in the shared guard
     * before any send — see src/agents/guardrails/guard.ts.
     */
    agent_paused: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

const contactBodySchema = z.object({
  name: z.string().min(1).max(200),
  title: z.string().max(120).optional(),
  department: z.string().max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  is_primary: z.boolean().optional(),
  // PRD-003 contact roles. Omitted on create means "primary if this is the
  // customer's first contact, otherwise other" — the service decides, because
  // it is the only place that knows. `is_primary` and a `primary` role are one
  // fact; the service reconciles them (src/modules/crm/contact-roles.ts).
  roles: z.array(contactRoleSchema).max(CONTACT_ROLES.length).optional(),
});

const contactPatchSchema = contactBodySchema
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

export const customers = new Hono<AuthedEnv>();

/**
 * The list carries each customer's health band so the console can badge the
 * table (PRD-003: "health badge on the customer list"). It costs **one** extra
 * query for the whole page — `getAllCustomerSignals` correlates off `customers`
 * rather than being called per row.
 */
customers.get("/", zValidator("query", pageQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { cursor, limit } = c.req.valid("query");
  const page = await listCustomers(c.env.DB, tenant.tenant_id, { cursor, limit });
  const signals = await getAllCustomerSignals(c.env.DB, tenant.tenant_id);
  return c.json({
    ...page,
    customers: page.customers.map((customer) => {
      const s = signals.get(customer.customer_id);
      // The list gets the band only; the reasons panel is a detail-page thing
      // and shipping the full list in every row would bloat the page payload
      // for something nothing renders.
      return { ...customer, health_band: s ? computeHealth(s).band : null };
    }),
  });
});

customers.post("/", zValidator("json", createBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const customer = await createCustomer(c.env, tenant.tenant_id, c.req.valid("json"));
  return c.json(customer, 201);
});

/**
 * Customer detail, plus the two derived blocks PRD-003 asks for.
 *
 * Both come from `getCustomerSignals` — **one** extra query, which is an
 * acceptance criterion ("adds no more than one additional query to the customer
 * detail endpoint"), not a preference. Adding a second read here is a
 * regression even if it looks harmless.
 */
customers.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const customer = await getCustomer(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!customer) return c.json({ error: "customer not found" }, 404);

  const signals = await getCustomerSignals(c.env.DB, tenant.tenant_id, customer.customer_id);
  return c.json({
    ...customer,
    // Credit is reported, never enforced. PRD-003: "warn only — do not block."
    // The console compares a draft invoice's total against these two numbers;
    // no server-side path rejects anything on their account.
    credit: {
      limit_cents: signals.credit_limit_cents,
      outstanding_ar_cents: signals.outstanding_ar_cents,
      available_cents:
        signals.credit_limit_cents === null
          ? null
          : signals.credit_limit_cents - signals.outstanding_ar_cents,
    },
    health: computeHealth(signals),
  });
});

customers.patch("/:id", zValidator("json", patchBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const customer = await updateCustomer(
      c.env.DB,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    return c.json(customer);
  } catch (err) {
    return crmErrorResponse(c, err);
  }
});

/**
 * Live collections-agent snapshot for this customer. Reads DO storage only
 * (idFromName/get are lazy and snapshot() never writes), so probing a
 * customer the agent has never touched returns `agent_state: null` without
 * creating state.
 */
customers.get("/:id/agent", async (c) => {
  const tenant = c.get("tenant");
  const id = c.env.COLLECTIONS_AGENT.idFromName(`${tenant.tenant_id}:${c.req.param("id")}`);
  const stub = c.env.COLLECTIONS_AGENT.get(id) as unknown as CollectionsAgent;
  const state = await stub.snapshot();
  if (!state) return c.json({ agent_state: null });
  const { tenant_id: _tenantId, ...agentState } = state;
  return c.json({ agent_state: agentState });
});

/** Native query over payments/payment_applications. */
customers.get("/:id/payment-history", async (c) => {
  const tenant = c.get("tenant");
  const history = await getPaymentHistory(c.env.DB, tenant.tenant_id, c.req.param("id"));
  return c.json({ payments: history });
});

customers.get("/:id/activities", async (c) => {
  const tenant = c.get("tenant");
  const activities = await listActivities(c.env.DB, tenant.tenant_id, c.req.param("id"));
  return c.json({ activities });
});

customers.get("/:id/contacts", async (c) => {
  const tenant = c.get("tenant");
  const contacts = await listContacts(c.env.DB, tenant.tenant_id, c.req.param("id"));
  return c.json({ contacts });
});

/**
 * PRD-003's `resolveContact(customerId, role)` over HTTP: requested role →
 * primary → any contact. `matched` says which rung answered, so a caller can
 * tell a real billing contact from a fallback.
 *
 * 200 with `contact: null` rather than 404 when the customer has no contacts —
 * "this customer has nobody" is a successful answer to the question, and it is
 * the answer S9's quote signing needs in order to leave the signatory field
 * blank rather than error. A missing *customer* is still a 404.
 */
customers.get("/:id/contacts/resolve", async (c) => {
  const tenant = c.get("tenant");
  const parsed = contactRoleSchema.safeParse(c.req.query("role") ?? "primary");
  if (!parsed.success) {
    return c.json({ error: `role must be one of: ${CONTACT_ROLES.join(", ")}` }, 400);
  }
  const customerId = c.req.param("id");
  if (!(await getCustomer(c.env.DB, tenant.tenant_id, customerId))) {
    return c.json({ error: "customer not found" }, 404);
  }
  const resolved = await resolveContact(c.env.DB, tenant.tenant_id, customerId, parsed.data);
  return c.json({
    contact: resolved?.contact ?? null,
    matched: resolved?.matched ?? null,
    requested_role: parsed.data,
  });
});

customers.post("/:id/contacts", zValidator("json", contactBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const contact = await createContact(c.env.DB, tenant.tenant_id, {
      customer_id: c.req.param("id"),
      ...c.req.valid("json"),
    });
    return c.json(contact, 201);
  } catch (err) {
    return crmErrorResponse(c, err);
  }
});

customers.patch("/:id/contacts/:contactId", zValidator("json", contactPatchSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const contact = await updateContact(
      c.env.DB,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.param("contactId"),
      c.req.valid("json"),
    );
    return c.json(contact);
  } catch (err) {
    return crmErrorResponse(c, err);
  }
});
