import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * Workstream 4 — `?limit=&cursor=` cursor pagination. IDs are ULIDs
 * (time-sortable), so paging by `id > cursor ORDER BY id ASC` gives stable,
 * non-overlapping pages as rows are inserted.
 */

const API_KEY = "test_api_key_page";
const TENANT_ID = "biz_page";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

async function seed() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Pagination Test SME", await sha256Hex(API_KEY))
    .run();
}

beforeAll(seed);

async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function createCustomers(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = await gatewayFetch("/v1/customers", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: `Customer ${i}` }),
    });
    const { customer_id } = (await res.json()) as { customer_id: string };
    ids.push(customer_id);
  }
  return ids;
}

describe("cursor pagination", () => {
  it("pages through the full set with no gaps or duplicates", async () => {
    const created = await createCustomers(12);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const qs = new URLSearchParams({ limit: "5" });
      if (cursor) qs.set("cursor", cursor);
      const res = await gatewayFetch(`/v1/customers?${qs}`, { headers: auth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        customers: { customer_id: string }[];
        next_cursor: string | null;
      };
      expect(body.customers.length).toBeLessThanOrEqual(5);
      seen.push(...body.customers.map((c) => c.customer_id));
      pages++;
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
      expect(pages).toBeLessThan(20); // guard against an infinite loop on a bug
    }

    for (const id of created) {
      expect(seen).toContain(id);
    }
    expect(new Set(seen).size).toBe(seen.length); // no duplicates across pages
  });

  it("next_cursor is null when everything fits in one page", async () => {
    const res = await gatewayFetch("/v1/customers?limit=200", { headers: auth });
    const body = (await res.json()) as { next_cursor: string | null };
    expect(body.next_cursor).toBeNull();
  });

  it("limit beyond the maximum is rejected, not silently truncated", async () => {
    const res = await gatewayFetch("/v1/customers?limit=99999", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("invoices list pagination composes with the status filter", async () => {
    for (let i = 0; i < 3; i++) {
      await gatewayFetch("/v1/invoices", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          customer_id: (await createCustomers(1))[0],
          currency: "MYR",
          due_date: "2026-06-26",
          lines: [{ description: "x", quantity: 1, unit_cents: 1000 }],
        }),
      });
    }
    const res = await gatewayFetch("/v1/invoices?status=draft&limit=2", { headers: auth });
    const body = (await res.json()) as { invoices: { status: string }[]; next_cursor: string | null };
    expect(body.invoices.length).toBeLessThanOrEqual(2);
    for (const inv of body.invoices) expect(inv.status).toBe("draft");
  });
});
