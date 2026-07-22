import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { setEnrichmentProviderFactoryForTests } from "../src/enrichment";
import type { Lead } from "../src/modules/crm/types";

const API_KEY = "test_api_key_sales";
const TENANT_ID = "biz_sales";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function seedTenant() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Sales Test SME", await sha256Hex(API_KEY))
    .run();
}

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createLead(body: Record<string, unknown>): Promise<Lead> {
  const res = await gatewayFetch("/v1/leads", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return res.json();
}

interface ConvertResult {
  lead: Lead;
  customer: { customer_id: string; name: string; email: string | null };
  contact: { contact_id: string; name: string; title: string | null; is_primary: boolean } | null;
  deal: { deal_id: string; stage_id: string; currency: string; status: string } | null;
}

async function convert(leadId: string, body: Record<string, unknown> = {}): Promise<Response> {
  return gatewayFetch(`/v1/leads/${leadId}/convert`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
}

beforeAll(seedTenant);
afterEach(() => setEnrichmentProviderFactoryForTests(null));

describe("leads CRUD", () => {
  it("creates a lead with defaults and reads it back", async () => {
    const lead = await createLead({ name: "Aina Prospect", company: "Prospect Sdn Bhd" });
    expect(lead.lead_id).toMatch(/^lead_/);
    expect(lead.status).toBe("new");
    expect(lead.source).toBe("manual");
    expect(lead.enriched_at).toBeNull();

    const res = await gatewayFetch(`/v1/leads/${lead.lead_id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Lead).name).toBe("Aina Prospect");

    const missing = await gatewayFetch("/v1/leads/lead_ghost", { headers: auth });
    expect(missing.status).toBe(404);
  });

  it("lists leads with a status filter and cursor pagination", async () => {
    const a = await createLead({ name: "Cursor A" });
    const b = await createLead({ name: "Cursor B" });
    await gatewayFetch(`/v1/leads/${b.lead_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ status: "qualified" }),
    });

    const qualified = await gatewayFetch("/v1/leads?status=qualified", { headers: auth });
    const qualifiedBody = (await qualified.json()) as { leads: Lead[] };
    expect(qualifiedBody.leads.map((l) => l.lead_id)).toContain(b.lead_id);
    expect(qualifiedBody.leads.every((l) => l.status === "qualified")).toBe(true);

    // Walk with limit=1: every page has one lead until the cursor runs out.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url = `/v1/leads?limit=1${cursor ? `&cursor=${cursor}` : ""}`;
      const page = (await (await gatewayFetch(url, { headers: auth })).json()) as {
        leads: Lead[];
        next_cursor: string | null;
      };
      expect(page.leads.length).toBeLessThanOrEqual(1);
      seen.push(...page.leads.map((l) => l.lead_id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toContain(a.lead_id);
    expect(seen).toContain(b.lead_id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("PATCH updates fields but never sets status=converted", async () => {
    const lead = await createLead({ name: "Patchable", email: "p@lead.example" });
    const res = await gatewayFetch(`/v1/leads/${lead.lead_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ title: "CTO", status: "qualified" }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Lead;
    expect(updated.title).toBe("CTO");
    expect(updated.status).toBe("qualified");
    expect(updated.email).toBe("p@lead.example");

    const sneaky = await gatewayFetch(`/v1/leads/${lead.lead_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ status: "converted" }),
    });
    expect(sneaky.status).toBe(400); // rejected by the route schema
  });
});

describe("lead conversion", () => {
  it("converts a company lead into customer + primary contact, no deal by default", async () => {
    const lead = await createLead({
      name: "Farah Buyer",
      company: "Buyer Corp",
      email: "farah@buyer.example",
      title: "Procurement Lead",
    });
    const res = await convert(lead.lead_id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConvertResult;

    expect(body.customer.name).toBe("Buyer Corp");
    expect(body.contact).not.toBeNull();
    expect(body.contact!.name).toBe("Farah Buyer");
    expect(body.contact!.is_primary).toBe(true);
    expect(body.deal).toBeNull();
    expect(body.lead.status).toBe("converted");
    expect(body.lead.converted_customer_id).toBe(body.customer.customer_id);
    expect(body.lead.converted_deal_id).toBeNull();

    // The contact is really attached to the customer.
    const contacts = await gatewayFetch(`/v1/customers/${body.customer.customer_id}/contacts`, {
      headers: auth,
    });
    const contactsBody = (await contacts.json()) as { contacts: { contact_id: string }[] };
    expect(contactsBody.contacts.map((c) => c.contact_id)).toContain(body.contact!.contact_id);
  });

  it("a lead without a company converts as a person-customer with no contact", async () => {
    const lead = await createLead({ name: "Solo Founder", email: "solo@founder.example" });
    const body = (await (await convert(lead.lead_id)).json()) as ConvertResult;
    expect(body.customer.name).toBe("Solo Founder");
    expect(body.contact).toBeNull();
  });

  it("optionally creates a deal in the first pipeline stage", async () => {
    const lead = await createLead({ name: "Deal Maker", company: "Deals Inc" });
    const res = await convert(lead.lead_id, {
      deal: { title: "First engagement", value_cents: 250_000, currency: "MYR" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConvertResult;
    expect(body.deal).not.toBeNull();
    expect(body.deal!.status).toBe("open");
    expect(body.lead.converted_deal_id).toBe(body.deal!.deal_id);

    const stages = (await (
      await gatewayFetch("/v1/deals/stages", { headers: auth })
    ).json()) as { stages: { stage_id: string }[] };
    expect(body.deal!.stage_id).toBe(stages.stages[0]!.stage_id);
  });

  it("refuses to convert converted or lost leads, and unknown leads 404", async () => {
    const lead = await createLead({ name: "One Shot" });
    expect((await convert(lead.lead_id)).status).toBe(200);
    expect((await convert(lead.lead_id)).status).toBe(409);

    // A converted lead is immutable via PATCH too.
    const patch = await gatewayFetch(`/v1/leads/${lead.lead_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ name: "Rewritten" }),
    });
    expect(patch.status).toBe(409);

    const lost = await createLead({ name: "Gone Cold" });
    await gatewayFetch(`/v1/leads/${lost.lead_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ status: "lost" }),
    });
    expect((await convert(lost.lead_id)).status).toBe(409);

    expect((await convert("lead_ghost")).status).toBe(404);
  });
});

describe("lead enrichment", () => {
  it("the default noop provider fills nothing and emits nothing", async () => {
    const lead = await createLead({ name: "Sparse Lead" });
    const res = await gatewayFetch(`/v1/leads/${lead.lead_id}/enrich`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lead: Lead; enriched_fields: string[] };
    expect(body.enriched_fields).toEqual([]);
    expect(body.lead.enriched_at).toBeNull();
  });

  it("a provider fills only empty fields and never overwrites operator data", async () => {
    setEnrichmentProviderFactoryForTests(() => ({
      name: "stub",
      enrichLead: async () => ({
        company: "Enriched Corp",
        email: "enriched@corp.example",
        title: "VP Engineering",
      }),
    }));

    const lead = await createLead({ name: "Half Known", email: "known@operator.example" });
    const res = await gatewayFetch(`/v1/leads/${lead.lead_id}/enrich`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lead: Lead; enriched_fields: string[] };
    expect(body.enriched_fields.sort()).toEqual(["company", "title"]);
    expect(body.lead.company).toBe("Enriched Corp");
    expect(body.lead.title).toBe("VP Engineering");
    expect(body.lead.email).toBe("known@operator.example"); // untouched
    expect(body.lead.enriched_at).not.toBeNull();
  });
});
