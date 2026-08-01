import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  accountId,
  bearer,
  fetchWorker,
  login,
  otherBearer,
  seedClaimsFixture,
  sessionHeaders,
} from "./claims-fixture";
import {
  CLAIM_EXPENSE_ACCOUNTS,
  DEFAULT_CLAIM_CATEGORIES,
  ensureClaimCategories,
} from "../src/modules/claims/categories";
import { SYSTEM_ACCOUNTS } from "../src/modules/finance/ledger";
import type { ClaimCategoryView } from "../src/modules/claims/types";

/**
 * PRD-006a — claim categories and their GL mapping.
 *
 * "Each mapped to a GL expense account. This mapping is what makes posting
 * possible." So the things worth testing are the mapping's integrity (an expense
 * account, this tenant's, not archived) and who is allowed to change it.
 */

beforeAll(seedClaimsFixture);

interface CategoriesBody {
  categories: ClaimCategoryView[];
}

describe("default categories", () => {
  it("seeds PRD-006's six categories, each mapped to an expense account", async () => {
    const res = await fetchWorker("/v1/claim-categories", { headers: bearer });
    expect(res.status).toBe(200);
    const { categories } = (await res.json()) as CategoriesBody;

    expect(categories.map((c) => c.code).sort()).toEqual(
      [...DEFAULT_CLAIM_CATEGORIES].map((c) => c.code).sort(),
    );
    // The mapping itself: every category resolves to a real expense account in
    // this tenant's own chart. If this holds, every category is postable.
    for (const category of categories) {
      expect(category.account_type).toBe("expense");
      expect(category.account_code).toMatch(/^5\d{3}$/);
      expect(category.expense_account_id).toBeTruthy();
      expect(category.account_archived_at).toBeNull();
    }
  });

  it("maps mileage to a per-km rate and nothing else to one", async () => {
    const res = await fetchWorker("/v1/claim-categories", { headers: bearer });
    const { categories } = (await res.json()) as CategoriesBody;

    const mileage = categories.find((c) => c.code === "mileage")!;
    expect(mileage.kind).toBe("mileage");
    expect(mileage.per_km_rate_cents).toBeGreaterThan(0);

    for (const other of categories.filter((c) => c.code !== "mileage")) {
      expect(other.kind).toBe("standard");
      expect(other.per_km_rate_cents).toBeNull();
    }
  });

  it("seeds no limits, so nobody starts out warned about correct claims", async () => {
    const res = await fetchWorker("/v1/claim-categories", { headers: bearer });
    const { categories } = (await res.json()) as CategoriesBody;
    expect(categories.every((c) => c.limit_cents === null)).toBe(true);
  });

  it("adds 2100 Employee Reimbursements Payable to the seeded chart", async () => {
    // The account both legs of every claim posting reference. In SYSTEM_ACCOUNTS
    // rather than seeded here, so it exists for a tenant that has never filed a
    // claim — and is a system account, so it cannot be archived out from under
    // the posting code.
    const row = await env.DB.prepare(
      "SELECT name, type, is_system FROM accounts WHERE tenant_id = ? AND code = '2100'",
    )
      .bind("biz_claims")
      .first<{ name: string; type: string; is_system: number }>();
    expect(row).toBeTruthy();
    expect(row!.name).toBe("Employee Reimbursements Payable");
    expect(row!.type).toBe("liability");
    expect(row!.is_system).toBe(1);

    expect(SYSTEM_ACCOUNTS.some((a) => a.code === "2100")).toBe(true);
  });

  it("seeds the category expense accounts as non-system, so a tenant can re-map them", async () => {
    const { results } = await env.DB.prepare(
      `SELECT code, is_system FROM accounts
        WHERE tenant_id = ? AND code IN ('5100','5200','5300','5400','5500') ORDER BY code`,
    )
      .bind("biz_claims")
      .all<{ code: string; is_system: number }>();
    expect(results).toHaveLength(CLAIM_EXPENSE_ACCOUNTS.length);
    expect(results.every((r) => r.is_system === 0)).toBe(true);
  });

  it("is idempotent — repeated seeding adds nothing", async () => {
    await ensureClaimCategories(env.DB, "biz_claims");
    await ensureClaimCategories(env.DB, "biz_claims");
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM claim_categories WHERE tenant_id = ?",
    )
      .bind("biz_claims")
      .first<{ n: number }>();
    expect(row!.n).toBe(DEFAULT_CLAIM_CATEGORIES.length);
  });

  it("keeps each tenant's categories and accounts separate", async () => {
    const mine = (await (await fetchWorker("/v1/claim-categories", { headers: bearer })).json()) as
      CategoriesBody;
    const theirs = (await (
      await fetchWorker("/v1/claim-categories", { headers: otherBearer })
    ).json()) as CategoriesBody;

    // Same codes, different rows and different accounts — the mapping is
    // per-tenant, which is what the composite FK enforces.
    expect(theirs.categories.map((c) => c.code).sort()).toEqual(
      mine.categories.map((c) => c.code).sort(),
    );
    const mineIds = new Set(mine.categories.map((c) => c.category_id));
    expect(theirs.categories.every((c) => !mineIds.has(c.category_id))).toBe(true);
    const mineAccounts = new Set(mine.categories.map((c) => c.expense_account_id));
    expect(theirs.categories.every((c) => !mineAccounts.has(c.expense_account_id))).toBe(true);
  });

  it("404s a category id from another tenant rather than confirming it exists", async () => {
    const theirs = (await (
      await fetchWorker("/v1/claim-categories", { headers: otherBearer })
    ).json()) as CategoriesBody;
    const res = await fetchWorker(`/v1/claim-categories/${theirs.categories[0]!.category_id}`, {
      headers: bearer,
    });
    expect(res.status).toBe(404);
  });
});

describe("the GL mapping is validated", () => {
  it("refuses a revenue account", async () => {
    const revenue = await accountId("4000");
    const res = await fetchWorker("/v1/claim-categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Bad Mapping", expense_account_id: revenue }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("expense account"),
    });
  });

  it("refuses another tenant's account", async () => {
    const theirAccount = await accountId("5200", "biz_claims_other");
    const res = await fetchWorker("/v1/claim-categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Cross Tenant", expense_account_id: theirAccount }),
    });
    expect(res.status).toBe(422);
  });

  it("refuses an archived account", async () => {
    const spare = await accountId("5400");
    await env.DB.prepare("UPDATE accounts SET archived_at = ? WHERE account_id = ?")
      .bind(new Date().toISOString(), spare)
      .run();

    const res = await fetchWorker("/v1/claim-categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Archived Target", expense_account_id: spare }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("archived");
  });

  it("requires a rate for a mileage category and forbids one otherwise", async () => {
    const expense = await accountId("5100");

    const noRate = await fetchWorker("/v1/claim-categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Mileage 2", expense_account_id: expense, kind: "mileage" }),
    });
    expect(noRate.status).toBe(422);

    const strayRate = await fetchWorker("/v1/claim-categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        name: "Not Mileage",
        expense_account_id: expense,
        per_km_rate_cents: 80,
      }),
    });
    expect(strayRate.status).toBe(422);
  });

  it("refuses a duplicate code", async () => {
    const expense = await accountId("5100");
    const res = await fetchWorker("/v1/claim-categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Meals Again", code: "meals", expense_account_id: expense }),
    });
    expect(res.status).toBe(409);
  });

  it("creates a category with a limit and re-maps it on patch", async () => {
    const expense = await accountId("5100");
    const created = await fetchWorker("/v1/claim-categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        name: "Client Entertainment",
        expense_account_id: expense,
        limit_cents: 50_000,
      }),
    });
    expect(created.status).toBe(201);
    const { category } = (await created.json()) as { category: ClaimCategoryView };
    expect(category.code).toBe("client_entertainment");
    expect(category.limit_cents).toBe(50_000);
    expect(category.account_code).toBe("5100");

    const remapped = await fetchWorker(`/v1/claim-categories/${category.category_id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ expense_account_id: await accountId("5200"), limit_cents: 25_000 }),
    });
    expect(remapped.status).toBe(200);
    const after = (await remapped.json()) as { category: ClaimCategoryView };
    expect(after.category.account_code).toBe("5200");
    expect(after.category.limit_cents).toBe(25_000);
  });

  it("clears the rate when a mileage category becomes standard", async () => {
    const mileage = (await (
      await fetchWorker("/v1/claim-categories", { headers: bearer })
    ).json()) as CategoriesBody;
    const id = mileage.categories.find((c) => c.code === "mileage")!.category_id;

    const res = await fetchWorker(`/v1/claim-categories/${id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ kind: "standard" }),
    });
    expect(res.status).toBe(200);
    const { category } = (await res.json()) as { category: ClaimCategoryView };
    expect(category.kind).toBe("standard");
    // Not left dangling: a standard category carrying a rate would fail its own
    // validation on the next patch.
    expect(category.per_km_rate_cents).toBeNull();
  });

  it("hides an archived category from the picklist but keeps it readable", async () => {
    const list = (await (
      await fetchWorker("/v1/claim-categories", { headers: bearer })
    ).json()) as CategoriesBody;
    const id = list.categories.find((c) => c.code === "supplies")!.category_id;

    await fetchWorker(`/v1/claim-categories/${id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ archived: true }),
    });

    const after = (await (
      await fetchWorker("/v1/claim-categories", { headers: bearer })
    ).json()) as CategoriesBody;
    expect(after.categories.some((c) => c.code === "supplies")).toBe(false);

    // Still resolvable by id, because a claim filed before it was archived has to
    // keep rendering and stay postable.
    const direct = await fetchWorker(`/v1/claim-categories/${id}`, { headers: bearer });
    expect(direct.status).toBe(200);

    const withArchived = (await (
      await fetchWorker("/v1/claim-categories?include_archived=true", { headers: bearer })
    ).json()) as CategoriesBody;
    expect(withArchived.categories.some((c) => c.code === "supplies")).toBe(true);
  });
});

describe("who may change the mapping", () => {
  it("lets an employee read the picklist — they cannot file a claim without it", async () => {
    const session = await login("filer");
    const res = await fetchWorker("/v1/claim-categories", { headers: sessionHeaders(session) });
    expect(res.status).toBe(200);
    const { categories } = (await res.json()) as CategoriesBody;
    expect(categories.length).toBeGreaterThan(0);
  });

  it("refuses a write from an employee: mapping to a GL account is a finance act", async () => {
    const session = await login("filer");
    const res = await fetchWorker("/v1/claim-categories", {
      method: "POST",
      headers: sessionHeaders(session),
      body: JSON.stringify({ name: "Employee Invented", expense_account_id: await accountId("5100") }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { required: string }).toMatchObject({
      required: "finance:write",
    });
  });

  it("allows a write from finance", async () => {
    const session = await login("finance");
    const res = await fetchWorker("/v1/claim-categories", {
      method: "POST",
      headers: sessionHeaders(session),
      body: JSON.stringify({
        name: "Training",
        expense_account_id: await accountId("5100"),
      }),
    });
    expect(res.status).toBe(201);
  });
});
