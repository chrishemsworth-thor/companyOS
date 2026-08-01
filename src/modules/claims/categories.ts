import { ulid } from "../../lib/ulid";
import { ensureSystemAccounts } from "../finance/ledger";
import { ClaimsError } from "./errors";
import {
  claimCategoryKindSchema,
  type ClaimCategory,
  type ClaimCategoryKind,
  type ClaimCategoryView,
} from "./types";

/**
 * Claim categories and the GL accounts they post to (PRD-006a).
 *
 * PRD-006: "Claim categories per tenant: mileage, meals, travel, accommodation,
 * supplies, other — each mapped to a GL expense account. This mapping is what
 * makes posting possible."
 *
 * Everything here is a seeded DEFAULT, not a rule. A tenant renames categories,
 * re-maps them to their own accounts, changes the mileage rate and sets limits;
 * nothing in the posting path depends on a particular code existing.
 */

/**
 * Expense accounts the default categories need, seeded alongside them.
 *
 * Not in `SYSTEM_ACCOUNTS`: those are the ledger's own machinery (cash, AR, AP,
 * equity, revenue) that posting code references by code, and a tenant cannot
 * archive them. These are ordinary chart lines that exist only because a default
 * category points at them, so they are seeded with `is_system = 0` and a tenant
 * is free to archive or re-map them. `2100 Employee Reimbursements Payable` IS
 * in `SYSTEM_ACCOUNTS`, because both legs of every claim posting reference it by
 * code.
 *
 * Codes are spaced by 100 in the 5xxx expense block, leaving room for a tenant's
 * own accounts between them.
 */
export const CLAIM_EXPENSE_ACCOUNTS = [
  { code: "5100", name: "Travel" },
  { code: "5200", name: "Meals & Entertainment" },
  { code: "5300", name: "Accommodation" },
  { code: "5400", name: "Office Supplies" },
  { code: "5500", name: "Mileage" },
] as const;

/** The account every claim posting credits. In SYSTEM_ACCOUNTS, seeded with the chart. */
export const REIMBURSEMENTS_PAYABLE_CODE = "2100";
/** The account a reimbursement payment credits. */
export const CASH_CODE = "1000";

/**
 * PRD-006's six categories, in its own order.
 *
 * The mileage rate is a **default a tenant edits**, not a statutory figure:
 * 70 sen/km sits in the middle of what Malaysian SMEs reimburse in practice.
 * Nothing computes from it except a mileage line at the moment it is created,
 * and that amount is then stored — so raising the rate next year cannot
 * retroactively change a posted claim.
 *
 * No limits are seeded. A limit only warns, but a wrong seeded limit would have
 * every tenant seeing warnings on correct claims from day one, which teaches
 * people to ignore the warning.
 */
export const DEFAULT_CLAIM_CATEGORIES: readonly {
  code: string;
  name: string;
  account_code: string;
  kind: ClaimCategoryKind;
  per_km_rate_cents: number | null;
}[] = [
  { code: "mileage", name: "Mileage", account_code: "5500", kind: "mileage", per_km_rate_cents: 70 },
  { code: "meals", name: "Meals", account_code: "5200", kind: "standard", per_km_rate_cents: null },
  { code: "travel", name: "Travel", account_code: "5100", kind: "standard", per_km_rate_cents: null },
  {
    code: "accommodation",
    name: "Accommodation",
    account_code: "5300",
    kind: "standard",
    per_km_rate_cents: null,
  },
  {
    code: "supplies",
    name: "Supplies",
    account_code: "5400",
    kind: "standard",
    per_km_rate_cents: null,
  },
  // Deliberately the existing general expense account rather than a sixth new
  // one: "other" is by definition unclassified, and a dedicated "Other Claims"
  // account would just be General Expenses under a second name.
  { code: "other", name: "Other", account_code: "5000", kind: "standard", per_km_rate_cents: null },
];

const CATEGORY_COLUMNS =
  "category_id, tenant_id, code, name, expense_account_id, kind, per_km_rate_cents, " +
  "limit_cents, archived_at, created_at, updated_at";

const CATEGORY_VIEW_SELECT = `SELECT ${CATEGORY_COLUMNS.split(", ")
  .map((c) => `cc.${c}`)
  .join(", ")},
         a.code AS account_code, a.name AS account_name, a.type AS account_type,
         a.archived_at AS account_archived_at
    FROM claim_categories cc
    JOIN accounts a ON a.tenant_id = cc.tenant_id AND a.account_id = cc.expense_account_id`;

/**
 * Seed the tenant's default chart lines and categories. Idempotent on both
 * (`INSERT OR IGNORE` against `UNIQUE (tenant_id, code)`), so it is safe to call
 * on every read of the category list — which is how a tenant gets them without
 * an onboarding step.
 *
 * Cheap by construction: two batches of small INSERT OR IGNOREs, no reads.
 */
export async function ensureClaimCategories(db: D1Database, tenantId: string): Promise<void> {
  // 2100 and 1000 come from here; the category accounts are seeded below.
  await ensureSystemAccounts(db, tenantId);

  await db.batch(
    CLAIM_EXPENSE_ACCOUNTS.map((account) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO accounts (account_id, tenant_id, code, name, type, is_system)
           VALUES (?, ?, ?, ?, 'expense', 0)`,
        )
        .bind(`acct_${ulid()}`, tenantId, account.code, account.name),
    ),
  );

  // The account_id is resolved by sub-select rather than a prior read: account
  // ids are per-tenant ULIDs, and this keeps the whole seed to one batch.
  await db.batch(
    DEFAULT_CLAIM_CATEGORIES.map((category) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO claim_categories
             (category_id, tenant_id, code, name, expense_account_id, kind, per_km_rate_cents)
           SELECT ?, ?, ?, ?, a.account_id, ?, ?
             FROM accounts a
            WHERE a.tenant_id = ? AND a.code = ?`,
        )
        .bind(
          `ccat_${ulid()}`,
          tenantId,
          category.code,
          category.name,
          category.kind,
          category.per_km_rate_cents,
          tenantId,
          category.account_code,
        ),
    ),
  );
}

/** Every category for a tenant, joined to its account. Archived ones only on request. */
export async function listClaimCategories(
  db: D1Database,
  tenantId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ClaimCategoryView[]> {
  const archivedClause = opts.includeArchived ? "" : "AND cc.archived_at IS NULL";
  const { results } = await db
    .prepare(
      `${CATEGORY_VIEW_SELECT}
        WHERE cc.tenant_id = ? ${archivedClause}
        ORDER BY cc.name`,
    )
    .bind(tenantId)
    .all<ClaimCategoryView>();
  return results ?? [];
}

/**
 * One category, joined to its account. Tenant-scoped in the WHERE clause, so
 * another tenant's id simply does not resolve.
 *
 * Returns archived categories too: a claim filed before the category was
 * archived still has to be readable and postable.
 */
export async function getClaimCategory(
  db: D1Database,
  tenantId: string,
  categoryId: string,
): Promise<ClaimCategoryView | null> {
  return db
    .prepare(`${CATEGORY_VIEW_SELECT} WHERE cc.tenant_id = ? AND cc.category_id = ?`)
    .bind(tenantId, categoryId)
    .first<ClaimCategoryView>();
}

/** The categories named by a set of ids, keyed for line-by-line lookup. */
export async function getClaimCategoriesByIds(
  db: D1Database,
  tenantId: string,
  categoryIds: readonly string[],
): Promise<Map<string, ClaimCategoryView>> {
  const unique = [...new Set(categoryIds)];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `${CATEGORY_VIEW_SELECT} WHERE cc.tenant_id = ? AND cc.category_id IN (${placeholders})`,
    )
    .bind(tenantId, ...unique)
    .all<ClaimCategoryView>();
  return new Map((results ?? []).map((row) => [row.category_id, row]));
}

export interface UpsertCategoryInput {
  code?: string;
  name: string;
  expense_account_id: string;
  kind?: ClaimCategoryKind;
  per_km_rate_cents?: number | null;
  limit_cents?: number | null;
}

/**
 * Validate the account a category is being mapped to.
 *
 * Three things SQL cannot express, all of which would otherwise surface as a
 * confusing failure at approval time rather than at configuration time:
 * the account must belong to this tenant, be an expense account, and not be
 * archived. A composite FK covers only the first.
 */
async function assertMappableAccount(
  db: D1Database,
  tenantId: string,
  accountId: string,
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT type, archived_at FROM accounts WHERE tenant_id = ? AND account_id = ?",
    )
    .bind(tenantId, accountId)
    .first<{ type: string; archived_at: string | null }>();
  if (!row) {
    // 422 rather than 404: the request is well-formed, it just names an account
    // this tenant does not have. A 404 would read as "no such category".
    throw new ClaimsError("invalid_request", `unknown account '${accountId}'`, 422);
  }
  if (row.type !== "expense") {
    throw new ClaimsError(
      "invalid_request",
      `account '${accountId}' is a ${row.type} account: a claim category must map to an expense account`,
      422,
    );
  }
  if (row.archived_at) {
    throw new ClaimsError(
      "invalid_request",
      `account '${accountId}' is archived and cannot be mapped to a claim category`,
      422,
    );
  }
}

/**
 * Mileage needs a rate and nothing else may carry one.
 *
 * Enforced rather than tolerated because a mileage category with no rate is a
 * category that cannot produce a line amount at all — the failure would land on
 * the employee filing the claim, not on whoever misconfigured it.
 */
function assertRateForKind(kind: ClaimCategoryKind, rate: number | null | undefined): void {
  if (kind === "mileage") {
    if (rate === null || rate === undefined || rate <= 0) {
      throw new ClaimsError(
        "invalid_request",
        "a mileage category needs a positive per_km_rate_cents",
        422,
      );
    }
    return;
  }
  if (rate !== null && rate !== undefined) {
    throw new ClaimsError(
      "invalid_request",
      "per_km_rate_cents applies only to a mileage category",
      422,
    );
  }
}

export async function createClaimCategory(
  db: D1Database,
  tenantId: string,
  input: UpsertCategoryInput,
): Promise<ClaimCategoryView> {
  const kind = claimCategoryKindSchema.parse(input.kind ?? "standard");
  assertRateForKind(kind, input.per_km_rate_cents);
  await assertMappableAccount(db, tenantId, input.expense_account_id);

  // A machine handle derived from the name when none is given, so the unique
  // index has something stable to work with either way.
  const code =
    input.code ??
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 60);
  if (!code) {
    throw new ClaimsError("invalid_request", "category code cannot be empty", 422);
  }

  const existing = await db
    .prepare("SELECT category_id FROM claim_categories WHERE tenant_id = ? AND code = ?")
    .bind(tenantId, code)
    .first();
  if (existing) {
    throw new ClaimsError(
      "invalid_request",
      `a claim category with code '${code}' already exists`,
      409,
    );
  }

  const categoryId = `ccat_${ulid()}`;
  await db
    .prepare(
      `INSERT INTO claim_categories
         (category_id, tenant_id, code, name, expense_account_id, kind, per_km_rate_cents, limit_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      categoryId,
      tenantId,
      code,
      input.name,
      input.expense_account_id,
      kind,
      input.per_km_rate_cents ?? null,
      input.limit_cents ?? null,
    )
    .run();

  return (await getClaimCategory(db, tenantId, categoryId))!;
}

export interface PatchCategoryInput {
  name?: string;
  expense_account_id?: string;
  kind?: ClaimCategoryKind;
  per_km_rate_cents?: number | null;
  limit_cents?: number | null;
  archived?: boolean;
}

/**
 * Edit a category. Re-mapping the account, changing the rate or changing the
 * limit affects only claims filed **after** the change: line amounts and posted
 * entries are stored, never recomputed.
 */
export async function patchClaimCategory(
  db: D1Database,
  tenantId: string,
  categoryId: string,
  patch: PatchCategoryInput,
): Promise<ClaimCategoryView> {
  const current = await getClaimCategory(db, tenantId, categoryId);
  if (!current) throw new ClaimsError("not_found", "claim category not found", 404);

  const kind = patch.kind ?? current.kind;
  // Switching to `standard` CLEARS the rate rather than validating the stored one:
  // a row that was mileage necessarily has a rate, so carrying it forward would
  // make "stop treating this as mileage" fail its own validation. An explicitly
  // supplied rate is still refused, because that is a contradiction rather than a
  // consequence.
  let rate: number | null;
  if (kind === "mileage") {
    rate =
      patch.per_km_rate_cents !== undefined ? patch.per_km_rate_cents : current.per_km_rate_cents;
  } else {
    assertRateForKind(kind, patch.per_km_rate_cents);
    rate = null;
  }
  assertRateForKind(kind, rate);
  if (patch.expense_account_id) {
    await assertMappableAccount(db, tenantId, patch.expense_account_id);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.expense_account_id !== undefined) set("expense_account_id", patch.expense_account_id);
  if (patch.kind !== undefined) set("kind", kind);
  if (patch.per_km_rate_cents !== undefined || patch.kind !== undefined) {
    // Kept consistent with `kind` even when only `kind` moved: switching a
    // category to standard has to clear the rate, or the row fails its own
    // validation on the next read.
    set("per_km_rate_cents", kind === "mileage" ? rate : null);
  }
  if (patch.limit_cents !== undefined) set("limit_cents", patch.limit_cents);
  if (patch.archived !== undefined) {
    set("archived_at", patch.archived ? new Date().toISOString() : null);
  }
  if (sets.length === 0) {
    throw new ClaimsError("invalid_request", "empty patch", 400);
  }
  set("updated_at", new Date().toISOString());

  await db
    .prepare(
      `UPDATE claim_categories SET ${sets.join(", ")} WHERE tenant_id = ? AND category_id = ?`,
    )
    .bind(...binds, tenantId, categoryId)
    .run();

  return (await getClaimCategory(db, tenantId, categoryId))!;
}

export type { ClaimCategory };
