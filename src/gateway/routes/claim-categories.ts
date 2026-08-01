import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireCapability } from "../middleware/capability";
import {
  createClaimCategory,
  ensureClaimCategories,
  getClaimCategory,
  listClaimCategories,
  patchClaimCategory,
} from "../../modules/claims/categories";
import { ClaimsError } from "../../modules/claims/errors";
import { claimCategoryKindSchema } from "../../modules/claims/types";

/**
 * Claim categories (PRD-006a), mounted at `/v1/claim-categories`.
 *
 * **Gating is deliberately asymmetric.** The router sits on the `self` capability
 * module so any login can *read* it: the category list is the picklist an
 * employee needs to file a claim, and the `employee` self-service tier holds
 * `self` and `meta` and nothing else. Mapping a category to a GL account, on the
 * other hand, is a chart-of-accounts act, so every write carries
 * `requireCapability("finance:write")` — the same pattern `/v1/people` uses to
 * hold its invite route to the `admin` bar inside an operator-writable router.
 *
 * Nothing sensitive is on the read side: a name, a kind, a rate, a limit and
 * which expense account it posts to.
 */
export const claimCategories = new Hono<AuthedEnv>();

const financeWrite = requireCapability("finance:write");

function categoriesErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof ClaimsError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  /** Derived from the name when omitted. The stable machine handle. */
  code: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/, "code must be lowercase letters, digits and underscores")
    .optional(),
  expense_account_id: z.string().min(1),
  kind: claimCategoryKindSchema.optional(),
  per_km_rate_cents: z.number().int().positive().nullable().optional(),
  limit_cents: z.number().int().positive().nullable().optional(),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(200),
    expense_account_id: z.string().min(1),
    kind: claimCategoryKindSchema,
    per_km_rate_cents: z.number().int().positive().nullable(),
    limit_cents: z.number().int().positive().nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "empty patch" });

/**
 * `GET /v1/claim-categories`
 *
 * Seeds PRD-006's six defaults on first read, so a tenant has a usable picklist
 * without an onboarding step. Idempotent (`INSERT OR IGNORE` on a unique code),
 * so calling it on every read costs two small batches and nothing else.
 */
claimCategories.get("/", async (c) => {
  const tenant = c.get("tenant");
  const includeArchived = c.req.query("include_archived") === "true";
  await ensureClaimCategories(c.env.DB, tenant.tenant_id);
  const categories = await listClaimCategories(c.env.DB, tenant.tenant_id, { includeArchived });
  return c.json({ categories });
});

/** `GET /v1/claim-categories/:id` — another tenant's id is a 404, not a 403. */
claimCategories.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const category = await getClaimCategory(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!category) return c.json({ error: "claim category not found" }, 404);
  return c.json({ category });
});

/** `POST /v1/claim-categories` — finance only. Validates the GL mapping. */
claimCategories.post("/", financeWrite, zValidator("json", createSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const category = await createClaimCategory(c.env.DB, tenant.tenant_id, c.req.valid("json"));
    return c.json({ category }, 201);
  } catch (err) {
    return categoriesErrorResponse(c, err);
  }
});

/**
 * `PATCH /v1/claim-categories/:id` — finance only.
 *
 * Re-mapping the account or changing the rate affects claims filed *after* the
 * change only: line amounts and posted entries are stored, never recomputed.
 */
claimCategories.patch("/:id", financeWrite, zValidator("json", patchSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const category = await patchClaimCategory(
      c.env.DB,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    return c.json({ category });
  } catch (err) {
    return categoriesErrorResponse(c, err);
  }
});
