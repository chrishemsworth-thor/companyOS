import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireCapability } from "../middleware/capability";
import { can } from "../../auth/capabilities";
import { IdempotencyConflict, withIdempotency } from "../idempotency";
import { pageQuerySchema } from "../pagination";
import { ClaimsError } from "../../modules/claims/errors";
import { getClaimDetail, isClaimApprover, listClaims } from "../../modules/claims/repo";
import {
  cancelClaim,
  createClaim,
  patchClaim,
  reimburseClaim,
  replaceClaimLines,
  resolveClaimEmployee,
  submitClaim,
  withdrawClaim,
} from "../../modules/claims/service";
import { claimStatusSchema } from "../../modules/claims/types";
import {
  FilesError,
  getFile,
  MAX_UPLOAD_BYTES_ANY_PURPOSE,
  MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
  tooLargeMessage,
  uploadFile,
} from "../../modules/files/service";
import { ApprovalsError } from "../../modules/approvals/service";
import { streamFile } from "./files";

/**
 * Expense claims (PRD-006a), mounted at `/v1/claims`.
 *
 * **On the `self` capability axis, not `people` or `finance`.** The same
 * reasoning as `/v1/approvals`: the `employee` self-service tier holds `self` and
 * nothing else, and employees are exactly the people filing claims. Gating this
 * on a business module would make the feature unusable by its primary user. The
 * People directory stays closed to them — it carries employment terms and HR
 * notes — and a claim carries neither.
 *
 * So authorization here is **per row, never per role**. A caller may see a claim
 * if any of:
 *
 *   1. it is their own (their `employees.user_id` link), or
 *   2. they are the approver on one of its approvals — a manager routed a claim
 *      by the C1 upward walk may hold no finance capability at all and cannot
 *      decide without seeing the receipt, or
 *   3. they hold `finance:read` — finance has to see the queue it reimburses.
 *
 * Recording the reimbursement is the one genuinely financial act, so it is held
 * to `finance:write` on the route.
 */
export const claims = new Hono<AuthedEnv>();

const financeWrite = requireCapability("finance:write");

function claimsErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof ClaimsError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  if (err instanceof IdempotencyConflict) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  // From the receipt upload route, which calls the files primitive: 413 for an
  // oversized image, 415 for an unsupported type. Surfaced with the primitive's
  // own message, which names the limits.
  if (err instanceof FilesError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  // From `submitClaim`, which raises the approval through the primitive. 422
  // `no_approver` means the employee's chain has nobody who can log in to
  // decide — a tenant configuration problem with a message that says so. Left
  // unhandled it surfaced as a 500, which reads as a server fault. Spotted
  // while wiring the same call into the quote send path (S9).
  if (err instanceof ApprovalsError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

/** The calling user's id, or null for a programmatic (tenant-API-key) caller. */
function callerUserId(c: Context<AuthedEnv>): string | null {
  const actor = c.get("user");
  return actor?.type === "user" && actor.id ? actor.id : null;
}

/**
 * May this caller **read** every claim in the tenant? Finance and above, or a
 * tenant API key (which bypasses the capability matrix everywhere, as a root
 * credential for agents).
 */
function seesAllClaims(c: Context<AuthedEnv>): boolean {
  const actor = c.get("user");
  if (!actor || actor.type !== "user") return true;
  return can(actor.role, "finance:read");
}

/**
 * May this caller **act on somebody else's** claim — edit it, submit it, file one
 * on their behalf?
 *
 * Deliberately a different question from `seesAllClaims`, and not derivable from
 * it. `readonly` holds `finance:read` (it is a full business observer) *and*
 * `self:write` (so an observer who is also staff can file their own claim), so a
 * read-based check here would let an observer edit a colleague's claim. The write
 * capability is the one that means "you administer other people's paperwork".
 */
function managesAllClaims(c: Context<AuthedEnv>): boolean {
  const actor = c.get("user");
  if (!actor || actor.type !== "user") return true;
  return can(actor.role, "finance:write") || can(actor.role, "people:write");
}

/**
 * Resolve the claim, then decide whether this caller may see it.
 *
 * Returns a `Response` when they may not — always a **404, never a 403**, so the
 * endpoint cannot be used to discover that a colleague filed a claim. Same rule
 * the files and approvals primitives apply to a cross-tenant id.
 */
async function loadVisibleClaim(c: Context<AuthedEnv>, claimId: string) {
  const tenant = c.get("tenant");
  const detail = await getClaimDetail(c.env.DB, tenant.tenant_id, claimId);
  if (!detail) return { error: c.json({ error: "claim not found" }, 404) } as const;

  if (seesAllClaims(c)) return { detail } as const;

  const userId = callerUserId(c);
  if (userId) {
    const own = await c.env.DB.prepare(
      "SELECT employee_id FROM employees WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(tenant.tenant_id, userId)
      .first<{ employee_id: string }>();
    if (own?.employee_id === detail.claim.employee_id) return { detail } as const;
    if (await isClaimApprover(c.env.DB, tenant.tenant_id, claimId, userId)) {
      return { detail } as const;
    }
  }
  return { error: c.json({ error: "claim not found" }, 404) } as const;
}

/**
 * A mutation the caller must own. Filing, editing, submitting and withdrawing are
 * the filer's actions; an approver's only verb is deciding, which happens through
 * the approvals primitive.
 */
async function requireOwnClaim(c: Context<AuthedEnv>, claimId: string) {
  const tenant = c.get("tenant");
  const detail = await getClaimDetail(c.env.DB, tenant.tenant_id, claimId);
  if (!detail) return { error: c.json({ error: "claim not found" }, 404) } as const;
  if (managesAllClaims(c)) return { detail } as const;

  const userId = callerUserId(c);
  if (!userId) return { error: c.json({ error: "claim not found" }, 404) } as const;
  const own = await c.env.DB.prepare(
    "SELECT employee_id FROM employees WHERE tenant_id = ? AND user_id = ?",
  )
    .bind(tenant.tenant_id, userId)
    .first<{ employee_id: string }>();
  if (own?.employee_id !== detail.claim.employee_id) {
    // 403 rather than 404 here: an approver CAN see this claim, so pretending it
    // does not exist would be a lie they can disprove by reading it.
    if (await isClaimApprover(c.env.DB, tenant.tenant_id, claimId, userId)) {
      return {
        error: c.json(
          {
            error: "only the claim's owner may change it; approve or reject it instead",
            code: "forbidden",
          },
          403,
        ),
      } as const;
    }
    return { error: c.json({ error: "claim not found" }, 404) } as const;
  }
  return { detail } as const;
}

const lineSchema = z.object({
  category_id: z.string().min(1),
  description: z.string().max(1000).nullable().optional(),
  /** Mileage categories only — the amount is computed from it. */
  distance_km: z.number().positive().nullable().optional(),
  /** Every other category. Gross: tax is part of it, not on top. */
  amount_cents: z.number().int().positive().nullable().optional(),
  tax_cents: z.number().int().nonnegative().nullable().optional(),
  receipt_file_id: z.string().min(1),
  project_id: z.string().nullable().optional(),
  department_code: z.string().nullable().optional(),
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO_DATE, "must be YYYY-MM-DD");

const createSchema = z.object({
  /** Omitted in the normal case — derived from the caller's employee link. */
  employee_id: z.string().nullable().optional(),
  claim_date: isoDate,
  description: z.string().max(2000).nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  project_id: z.string().nullable().optional(),
  department_code: z.string().nullable().optional(),
  lines: z.array(lineSchema).min(1),
});

const patchSchema = z
  .object({
    claim_date: isoDate,
    description: z.string().max(2000).nullable(),
    currency: z.string().length(3),
    project_id: z.string().nullable(),
    department_code: z.string().nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "empty patch" });

const linesSchema = z.object({ lines: z.array(lineSchema).min(1) });

const reimburseSchema = z
  .object({
    paid_on: isoDate.optional(),
    payment_reference: z.string().max(200).nullable().optional(),
  })
  .optional();

const listQuerySchema = pageQuerySchema.extend({
  status: claimStatusSchema.optional(),
  employee_id: z.string().optional(),
  /** `?mine=true` — the caller's own claims. */
  mine: z.enum(["true", "false"]).optional(),
  /** `?awaiting_me=true` — claims the caller is the approver on. */
  awaiting_me: z.enum(["true", "false"]).optional(),
});

/**
 * `GET /v1/claims`
 *
 * Defaults to the caller's own claims for anyone without `finance:read`, rather
 * than 403-ing: an employee listing claims wants theirs, and making them pass
 * `?mine=true` to get a non-empty list would be a trap.
 */
claims.get("/", async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "invalid_request" }, 400);
  }
  const query = parsed.data;
  const tenant = c.get("tenant");
  const userId = callerUserId(c);

  const filter: Parameters<typeof listClaims>[2] = {
    limit: query.limit,
    cursor: query.cursor,
    status: query.status,
    employee_id: query.employee_id,
  };

  if (query.awaiting_me === "true") {
    if (!userId) {
      return c.json(
        {
          error: "?awaiting_me=true requires a user session; a tenant API key has no user identity",
          code: "invalid_request",
        },
        400,
      );
    }
    filter.approver_user_id = userId;
  } else if (query.mine === "true" || !seesAllClaims(c)) {
    if (!userId) {
      return c.json(
        { error: "?mine=true requires a user session", code: "invalid_request" },
        400,
      );
    }
    try {
      filter.employee_id = await resolveClaimEmployee(c.env.DB, tenant.tenant_id, userId);
    } catch (err) {
      // A login with no employee record has no claims rather than an error: an
      // empty list is the honest answer for an external admin.
      if (err instanceof ClaimsError && err.code === "invalid_request") {
        return c.json({ claims: [], next_cursor: null });
      }
      throw err;
    }
  }

  return c.json(await listClaims(c.env.DB, tenant.tenant_id, filter));
});

/**
 * `POST /v1/claims/receipts` — multipart upload of one receipt.
 *
 * **Why this exists rather than sending filers to `POST /v1/files`.** The files
 * router is gated on `files:write`, and the `employee` self-service tier holds
 * only `self` and `meta` — so the person PRD-006 is built for cannot use it. The
 * alternatives were widening `employee` to `files:write` (which would let them
 * upload a tenant logo or a signature, neither of which is theirs to touch) or
 * this: one purpose-locked route on the axis they already hold.
 *
 * It still goes through the files primitive — `uploadFile()`, never R2 — so the
 * per-purpose policy, the tenant-scoped object key and the SHA-256 all apply
 * unchanged. `purpose` is forced to `claim_receipt` and is not a form field, so
 * this route cannot be used to write any other kind of file.
 *
 * Registered before `/:id` so the literal path is not swallowed by the parameter.
 */
claims.post("/receipts", async (c) => {
  const declared = Number(c.req.header("Content-Length") ?? "");
  if (
    Number.isFinite(declared) &&
    declared > MAX_UPLOAD_BYTES_ANY_PURPOSE + MULTIPART_OVERHEAD_ALLOWANCE_BYTES
  ) {
    return c.json({ error: tooLargeMessage(MAX_UPLOAD_BYTES_ANY_PURPOSE), code: "too_large" }, 413);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(
      { error: "expected a multipart/form-data body with a 'file' part", code: "invalid_request" },
      400,
    );
  }
  const part = form.get("file");
  if (!part || typeof part === "string") {
    return c.json({ error: "missing 'file' part", code: "invalid_request" }, 400);
  }
  if (!part.type) {
    return c.json(
      { error: "the 'file' part must declare a Content-Type", code: "invalid_request" },
      400,
    );
  }
  const nameOverride = form.get("filename");
  const filename =
    typeof nameOverride === "string" && nameOverride !== ""
      ? nameOverride
      : ((part as File).name ?? "receipt");

  const actor = c.get("user");
  const tenant = c.get("tenant");
  try {
    const metadata = await uploadFile(c.env, tenant.tenant_id, {
      bytes: await part.arrayBuffer(),
      filename: filename.slice(0, 300),
      contentType: part.type,
      // Not a form field. A filer cannot choose to write some other purpose.
      purpose: "claim_receipt",
      uploadedBy: actor?.type === "user" ? (actor.id ?? null) : null,
    });
    return c.json(metadata, 201);
  } catch (err) {
    return claimsErrorResponse(c, err);
  }
});

/**
 * `GET /v1/claims/:id` — header, lines, receipts and limit status.
 *
 * This is what the inbox's claim card reads, which is why the approver is on the
 * visibility list.
 */
claims.get("/:id", async (c) => {
  const result = await loadVisibleClaim(c, c.req.param("id"));
  if ("error" in result) return result.error;
  return c.json(result.detail);
});

/**
 * `GET /v1/claims/:id/lines/:line/receipt` — stream one line's receipt.
 *
 * Authorization follows the **claim**, not a files capability: whoever may see
 * the claim may see its receipts. That is the correct boundary and the only one
 * that works — the approver deciding the claim and the employee who filed it both
 * typically hold no `files:read` at all, and PRD-006's second submission
 * criterion ("a JPEG receipt uploads and displays in the approval view") is
 * exactly this request.
 *
 * The bytes come from the files primitive and the response is built by the same
 * `streamFile` the `/v1/files` route uses, so the headers, ETag and filename
 * handling are identical.
 */
claims.get("/:id/lines/:line/receipt", async (c) => {
  const result = await loadVisibleClaim(c, c.req.param("id"));
  if ("error" in result) return result.error;

  const lineNo = Number(c.req.param("line"));
  const line = result.detail.lines.find((l) => l.line_no === lineNo);
  if (!line) return c.json({ error: "claim line not found" }, 404);

  const tenant = c.get("tenant");
  const file = await getFile(c.env.DB, tenant.tenant_id, line.receipt_file_id);
  // The row survives a soft-deleted receipt (the LEFT JOIN in the repo), so this
  // is a normal condition rather than an inconsistency: the claim renders and the
  // receipt reads as unavailable.
  if (!file) return c.json({ error: "receipt not found" }, 404);
  // Private: a receipt is a photo of somebody's lunch bill.
  return streamFile(c.env, file, "private, max-age=300");
});

/** `POST /v1/claims` — create a draft with its lines. */
claims.post("/", zValidator("json", createSchema), async (c) => {
  const tenant = c.get("tenant");
  const body = c.req.valid("json");
  try {
    const result = await withIdempotency(
      c.env.DB,
      tenant.tenant_id,
      "POST /v1/claims",
      c.req.header("Idempotency-Key"),
      body,
      async () => {
        const detail = await createClaim(
          c.env,
          tenant.tenant_id,
          {
            user_id: callerUserId(c),
            // Filing on somebody else's behalf is an HR/finance act, not a
            // self-service one. An `employee` login may only file for itself, and
            // so may a `readonly` observer — see `managesAllClaims`.
            may_file_for_others: managesAllClaims(c),
          },
          body,
        );
        return { status: 201 as const, body: detail };
      },
    );
    return c.json(result.body, result.status);
  } catch (err) {
    return claimsErrorResponse(c, err);
  }
});

/** `PATCH /v1/claims/:id` — header edits. `draft`/`rejected` only; 409 otherwise. */
claims.patch("/:id", zValidator("json", patchSchema), async (c) => {
  const owned = await requireOwnClaim(c, c.req.param("id"));
  if ("error" in owned) return owned.error;
  const tenant = c.get("tenant");
  try {
    return c.json(
      await patchClaim(c.env, tenant.tenant_id, c.req.param("id"), c.req.valid("json")),
    );
  } catch (err) {
    return claimsErrorResponse(c, err);
  }
});

/** `PUT /v1/claims/:id/lines` — replace the line set, recomputing the header total. */
claims.put("/:id/lines", zValidator("json", linesSchema), async (c) => {
  const owned = await requireOwnClaim(c, c.req.param("id"));
  if ("error" in owned) return owned.error;
  const tenant = c.get("tenant");
  try {
    return c.json(
      await replaceClaimLines(c.env, tenant.tenant_id, c.req.param("id"), c.req.valid("json").lines),
    );
  } catch (err) {
    return claimsErrorResponse(c, err);
  }
});

/**
 * `POST /v1/claims/:id/submit` — ask for a decision.
 *
 * Also the resubmission route for a rejected claim, which raises a NEW approval
 * (SESSION-PLAN C8). The response carries `limit_warnings`: PRD-006 wants an
 * over-limit category to warn and still submit, so this is a 200 with advice
 * rather than a 4xx.
 */
claims.post("/:id/submit", async (c) => {
  const owned = await requireOwnClaim(c, c.req.param("id"));
  if ("error" in owned) return owned.error;
  const tenant = c.get("tenant");
  try {
    return c.json(await submitClaim(c.env, tenant.tenant_id, c.req.param("id"), callerUserId(c)));
  } catch (err) {
    return claimsErrorResponse(c, err);
  }
});

/** `POST /v1/claims/:id/withdraw` — take it back off the approver's queue. */
claims.post("/:id/withdraw", async (c) => {
  const owned = await requireOwnClaim(c, c.req.param("id"));
  if ("error" in owned) return owned.error;
  const tenant = c.get("tenant");
  try {
    return c.json(await withdrawClaim(c.env, tenant.tenant_id, c.req.param("id")));
  } catch (err) {
    return claimsErrorResponse(c, err);
  }
});

/** `POST /v1/claims/:id/cancel` — abandon a draft or rejected claim. */
claims.post("/:id/cancel", async (c) => {
  const owned = await requireOwnClaim(c, c.req.param("id"));
  if ("error" in owned) return owned.error;
  const tenant = c.get("tenant");
  try {
    return c.json(await cancelClaim(c.env, tenant.tenant_id, c.req.param("id")));
  } catch (err) {
    return claimsErrorResponse(c, err);
  }
});

/**
 * `POST /v1/claims/:id/reimburse` — finance only.
 *
 * Posts `Dr Employee Reimbursements Payable / Cr Cash` and marks the claim `paid`,
 * in one batch. Idempotent on `Idempotency-Key`, because paying somebody twice is
 * the worst outcome on this route.
 */
claims.post("/:id/reimburse", financeWrite, async (c) => {
  let raw: unknown = {};
  try {
    const text = await c.req.text();
    if (text) raw = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid JSON body", code: "invalid_request" }, 400);
  }
  const parsed = reimburseSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "invalid_request" }, 400);
  }

  const tenant = c.get("tenant");
  const claimId = c.req.param("id");
  try {
    const result = await withIdempotency(
      c.env.DB,
      tenant.tenant_id,
      `POST /v1/claims/${claimId}/reimburse`,
      c.req.header("Idempotency-Key"),
      parsed.data ?? {},
      async () => ({
        status: 200 as const,
        body: await reimburseClaim(c.env, tenant.tenant_id, claimId, parsed.data ?? {}),
      }),
    );
    return c.json(result.body, result.status);
  } catch (err) {
    return claimsErrorResponse(c, err);
  }
});
