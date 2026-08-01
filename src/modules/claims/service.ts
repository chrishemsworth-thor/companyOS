import { DEPARTMENT_IDS } from "../../departments/registry";
import { ulid } from "../../lib/ulid";
import { makeEnvelope } from "../../schemas/envelope";
import { cancelForSubject, requestApproval } from "../approvals/service";
import { resolveBaseCurrency } from "../quotes/settings";
import { ensureClaimCategories, getClaimCategoriesByIds } from "./categories";
import { ClaimsError } from "./errors";
import { buildClaimPaymentPosting } from "./posting";
import {
  getClaim,
  getClaimDetail,
  getClaimLimitWarnings,
  getClaimLines,
} from "./repo";
import {
  canTransitionClaim,
  isEditableClaimStatus,
  type ClaimDetail,
  type ClaimLineInput,
  type ClaimStatus,
  type CreateClaimInput,
  type ExpenseClaim,
  type PatchClaimInput,
} from "./types";

/**
 * Expense claims — the write path (PRD-006a).
 *
 * What this module deliberately does NOT do, per standing rule 2:
 *
 *  - **No approvals table and no decision route of its own.** Submitting calls
 *    `requestApproval()` with `subject_type = 'expense_claim'`; the decision
 *    arrives through the primitive's own `POST /v1/approvals/:id/approve`, and
 *    the claim's half of it lives in ./decision.ts as a registered effect so the
 *    posting is atomic with the decision.
 *  - **No notifications.** The `approval.*` consumer already tells the approver a
 *    decision is needed and the employee what was decided.
 *  - **No R2 access.** Receipts go through the files primitive with
 *    `purpose = 'claim_receipt'`; this module only ever holds a `file_id`.
 */

interface ClaimsEnv {
  DB: D1Database;
  EVENTS: Queue;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A resolved, validated line ready to be written. */
interface ResolvedLine {
  line_no: number;
  category_id: string;
  description: string | null;
  distance_km: number | null;
  amount_cents: number;
  tax_cents: number;
  receipt_file_id: string;
  project_id: string | null;
  department_code: string | null;
}

function assertEditable(claim: ExpenseClaim): void {
  if (!isEditableClaimStatus(claim.status)) {
    // PRD-006: "Given an approved claim, when edited, then 409 — approved claims
    // are immutable because they have hit the ledger." The message names the
    // state, matching the Support state-machine convention.
    throw new ClaimsError(
      "illegal_transition",
      claim.status === "approved" || claim.status === "paid"
        ? `claim is ${claim.status} and cannot be edited: it has been posted to the ledger`
        : `claim is ${claim.status} and cannot be edited`,
      409,
    );
  }
}

function assertClaimTransition(claim: ExpenseClaim, to: ClaimStatus): void {
  if (!canTransitionClaim(claim.status, to)) {
    throw new ClaimsError(
      "illegal_transition",
      `claim is ${claim.status} and cannot become ${to}`,
      409,
    );
  }
}

/**
 * `department_code` is the one dimension with a closed vocabulary — it names a
 * department in the in-code registry, so nothing at the SQL level can reject a
 * typo. Validated here as well as in the ledger so the filer gets a 422 at
 * submission rather than the approver getting a failure at approval.
 */
function assertDepartment(code: string | null | undefined, where: string): void {
  if (code === undefined || code === null) return;
  if (!DEPARTMENT_IDS.includes(code)) {
    throw new ClaimsError("invalid_request", `unknown department_code '${code}' on ${where}`, 422);
  }
}

/**
 * A project dimension that names nothing is worse than none at all: PRD-001a's
 * rollup falls back to the raw id for a project it cannot resolve, so a typo
 * silently creates a phantom bucket competing with real ones in the margin table.
 */
async function assertProject(
  db: D1Database,
  tenantId: string,
  projectId: string | null | undefined,
  where: string,
): Promise<void> {
  if (!projectId) return;
  const row = await db
    .prepare("SELECT 1 AS hit FROM projects WHERE tenant_id = ? AND project_id = ?")
    .bind(tenantId, projectId)
    .first();
  if (!row) {
    throw new ClaimsError("invalid_request", `unknown project '${projectId}' on ${where}`, 422);
  }
}

/**
 * Every receipt must be a live `claim_receipt` upload belonging to this tenant.
 *
 * The composite FK already stops a cross-tenant file id, but not a wrong-purpose
 * one — and purpose is what carries the size and content-type policy. A tenant
 * logo attached as a receipt would be a 2 MB image that passed no receipt check.
 */
async function assertReceipts(
  db: D1Database,
  tenantId: string,
  fileIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return;
  const placeholders = unique.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT file_id, purpose FROM files
        WHERE tenant_id = ? AND file_id IN (${placeholders}) AND deleted_at IS NULL`,
    )
    .bind(tenantId, ...unique)
    .all<{ file_id: string; purpose: string }>();
  const found = new Map((results ?? []).map((r) => [r.file_id, r.purpose]));
  for (const fileId of unique) {
    const purpose = found.get(fileId);
    if (!purpose) {
      throw new ClaimsError("invalid_request", `receipt file '${fileId}' not found`, 422);
    }
    if (purpose !== "claim_receipt") {
      throw new ClaimsError(
        "invalid_request",
        `file '${fileId}' has purpose '${purpose}': a receipt must be uploaded with purpose 'claim_receipt'`,
        422,
      );
    }
  }
}

/**
 * Validate and resolve the line inputs, computing mileage amounts.
 *
 * Mileage is the only line whose money the filer does not supply: the amount is
 * `distance_km x per_km_rate_cents`, rounded to the cent, and **stored**. Storing
 * it is what makes a posted claim reproducible after a tenant edits the rate.
 */
async function resolveLines(
  db: D1Database,
  tenantId: string,
  lines: readonly ClaimLineInput[],
): Promise<ResolvedLine[]> {
  if (lines.length === 0) {
    throw new ClaimsError("invalid_request", "a claim needs at least one line", 422);
  }

  const categories = await getClaimCategoriesByIds(
    db,
    tenantId,
    lines.map((line) => line.category_id),
  );
  await assertReceipts(
    db,
    tenantId,
    lines.map((line) => line.receipt_file_id),
  );

  const resolved: ResolvedLine[] = [];
  for (const [index, line] of lines.entries()) {
    const where = `line ${index + 1}`;
    const category = categories.get(line.category_id);
    if (!category) {
      throw new ClaimsError(
        "invalid_request",
        `unknown claim category '${line.category_id}' on ${where}`,
        422,
      );
    }
    if (category.archived_at) {
      throw new ClaimsError(
        "invalid_request",
        `claim category '${category.name}' is archived and cannot be used on ${where}`,
        422,
      );
    }
    if (!line.receipt_file_id) {
      // PRD-006's first submission criterion. Enforced here rather than only by
      // the NOT NULL column so the message says what to do about it.
      throw new ClaimsError(
        "invalid_request",
        `${where} has no receipt: every claim line needs one`,
        422,
      );
    }
    assertDepartment(line.department_code, where);
    await assertProject(db, tenantId, line.project_id, where);

    let amount: number;
    if (category.kind === "mileage") {
      const distance = line.distance_km;
      if (distance === undefined || distance === null || !(distance > 0)) {
        throw new ClaimsError(
          "invalid_request",
          `${where} uses mileage category '${category.name}' and needs a positive distance_km`,
          422,
        );
      }
      if (line.amount_cents !== undefined && line.amount_cents !== null) {
        // Refused rather than ignored: silently discarding a number the filer
        // typed would have them believe they claimed something they did not.
        throw new ClaimsError(
          "invalid_request",
          `${where} is a mileage line: the amount is computed from distance_km x the category rate, so amount_cents must be omitted`,
          422,
        );
      }
      amount = Math.round(distance * (category.per_km_rate_cents ?? 0));
      if (amount <= 0) {
        throw new ClaimsError(
          "invalid_request",
          `${where} computes to zero: check the distance and the category's per-km rate`,
          422,
        );
      }
    } else {
      const given = line.amount_cents;
      if (given === undefined || given === null || !Number.isInteger(given) || given <= 0) {
        throw new ClaimsError(
          "invalid_request",
          `${where} needs a positive integer amount_cents`,
          422,
        );
      }
      if (line.distance_km !== undefined && line.distance_km !== null) {
        throw new ClaimsError(
          "invalid_request",
          `${where} uses category '${category.name}', which is not a mileage category: distance_km does not apply`,
          422,
        );
      }
      amount = given;
    }

    const tax = line.tax_cents ?? 0;
    if (!Number.isInteger(tax) || tax < 0) {
      throw new ClaimsError("invalid_request", `${where} has an invalid tax_cents`, 422);
    }
    if (tax > amount) {
      // The line amount is GROSS — tax is part of it, not on top of it. See the
      // SST note in posting.ts.
      throw new ClaimsError(
        "invalid_request",
        `${where} has tax_cents (${tax}) greater than its amount (${amount}): the line amount is gross and includes tax`,
        422,
      );
    }

    resolved.push({
      line_no: index + 1,
      category_id: line.category_id,
      description: line.description ?? null,
      distance_km: category.kind === "mileage" ? (line.distance_km ?? null) : null,
      amount_cents: amount,
      tax_cents: tax,
      receipt_file_id: line.receipt_file_id,
      project_id: line.project_id ?? null,
      department_code: line.department_code ?? null,
    });
  }
  return resolved;
}

function lineInsertStatements(
  db: D1Database,
  tenantId: string,
  claimId: string,
  lines: readonly ResolvedLine[],
): D1PreparedStatement[] {
  return lines.map((line) =>
    db
      .prepare(
        `INSERT INTO expense_claim_lines
           (tenant_id, claim_id, line_no, category_id, description, distance_km,
            amount_cents, tax_cents, receipt_file_id, project_id, department_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        claimId,
        line.line_no,
        line.category_id,
        line.description,
        line.distance_km,
        line.amount_cents,
        line.tax_cents,
        line.receipt_file_id,
        line.project_id,
        line.department_code,
      ),
  );
}

function totalsOf(lines: readonly ResolvedLine[]): { total_cents: number; tax_cents: number } {
  return {
    total_cents: lines.reduce((sum, line) => sum + line.amount_cents, 0),
    tax_cents: lines.reduce((sum, line) => sum + line.tax_cents, 0),
  };
}

/**
 * The employee a user files claims as.
 *
 * A login with no employee record has no claim to file — an external admin, say.
 * That is a 422 rather than a 404: nothing is missing, the caller just is not in
 * the employee directory, and the fix is an HR action.
 */
export async function resolveClaimEmployee(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<string> {
  const row = await db
    .prepare("SELECT employee_id FROM employees WHERE tenant_id = ? AND user_id = ?")
    .bind(tenantId, userId)
    .first<{ employee_id: string }>();
  if (!row) {
    throw new ClaimsError(
      "invalid_request",
      "no employee record is linked to this login, so there is nobody to file a claim for",
      422,
    );
  }
  return row.employee_id;
}

export interface CreateClaimActor {
  /** The calling user, or null for a programmatic (tenant-API-key) caller. */
  user_id: string | null;
  /** True when the caller may file on another employee's behalf. */
  may_file_for_others: boolean;
}

/**
 * Create a claim in `draft`, with its lines.
 *
 * Draft rather than submitted-on-create so the filer can add a second receipt
 * without racing an approver, and so the "no receipt" rejection lands on submit
 * where the employee is looking. `POST /v1/claims/:id/submit` is the act that
 * asks somebody for a decision.
 */
export async function createClaim(
  env: ClaimsEnv,
  tenantId: string,
  actor: CreateClaimActor,
  input: CreateClaimInput,
): Promise<ClaimDetail> {
  if (!ISO_DATE.test(input.claim_date)) {
    throw new ClaimsError("invalid_request", "claim_date must be YYYY-MM-DD", 400);
  }
  await ensureClaimCategories(env.DB, tenantId);

  let employeeId: string;
  if (input.employee_id) {
    if (!actor.may_file_for_others && actor.user_id) {
      // Resolved rather than compared blind, and a caller with no employee record
      // of their own gets the SAME 403 rather than the "you are not in the
      // directory" 422 — they have named somebody else's employee id, and that is
      // the more accurate reason to refuse. The 422 is right only when somebody is
      // filing for themselves and there is no self to resolve.
      const own = await resolveClaimEmployee(env.DB, tenantId, actor.user_id).catch(() => null);
      if (own !== input.employee_id) {
        throw new ClaimsError("forbidden", "you may only file claims for yourself", 403);
      }
    }
    const exists = await env.DB.prepare(
      "SELECT 1 AS hit FROM employees WHERE tenant_id = ? AND employee_id = ?",
    )
      .bind(tenantId, input.employee_id)
      .first();
    if (!exists) {
      throw new ClaimsError("invalid_request", `unknown employee '${input.employee_id}'`, 422);
    }
    employeeId = input.employee_id;
  } else {
    if (!actor.user_id) {
      throw new ClaimsError(
        "invalid_request",
        "employee_id is required when there is no user session to derive it from",
        400,
      );
    }
    employeeId = await resolveClaimEmployee(env.DB, tenantId, actor.user_id);
  }

  assertDepartment(input.department_code, "the claim");
  await assertProject(env.DB, tenantId, input.project_id, "the claim");
  const lines = await resolveLines(env.DB, tenantId, input.lines);
  const totals = totalsOf(lines);
  const currency = input.currency ?? (await resolveBaseCurrency(env.DB, tenantId));

  const claimId = `clm_${ulid()}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO expense_claims
         (claim_id, tenant_id, employee_id, claim_date, description, currency,
          total_cents, tax_cents, status, project_id, department_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).bind(
      claimId,
      tenantId,
      employeeId,
      input.claim_date,
      input.description ?? null,
      currency,
      totals.total_cents,
      totals.tax_cents,
      input.project_id ?? null,
      input.department_code ?? null,
    ),
    ...lineInsertStatements(env.DB, tenantId, claimId, lines),
  ]);

  return (await getClaimDetail(env.DB, tenantId, claimId))!;
}

/** Edit the header. `draft`/`rejected` only — everything else 409s. */
export async function patchClaim(
  env: ClaimsEnv,
  tenantId: string,
  claimId: string,
  patch: PatchClaimInput,
): Promise<ClaimDetail> {
  const claim = await getClaim(env.DB, tenantId, claimId);
  if (!claim) throw new ClaimsError("not_found", "claim not found", 404);
  assertEditable(claim);

  if (patch.claim_date !== undefined && !ISO_DATE.test(patch.claim_date)) {
    throw new ClaimsError("invalid_request", "claim_date must be YYYY-MM-DD", 400);
  }
  assertDepartment(patch.department_code, "the claim");
  await assertProject(env.DB, tenantId, patch.project_id, "the claim");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };
  if (patch.claim_date !== undefined) set("claim_date", patch.claim_date);
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.currency !== undefined) set("currency", patch.currency);
  if (patch.project_id !== undefined) set("project_id", patch.project_id);
  if (patch.department_code !== undefined) set("department_code", patch.department_code);
  if (sets.length === 0) throw new ClaimsError("invalid_request", "empty patch", 400);
  set("updated_at", new Date().toISOString());

  await env.DB.prepare(
    `UPDATE expense_claims SET ${sets.join(", ")} WHERE tenant_id = ? AND claim_id = ?`,
  )
    .bind(...binds, tenantId, claimId)
    .run();

  return (await getClaimDetail(env.DB, tenantId, claimId))!;
}

/**
 * Replace the claim's lines wholesale, recomputing the header totals in the same
 * batch.
 *
 * Wholesale rather than per-line CRUD because the header total must equal the sum
 * of the lines (PRD-006's third submission criterion) and a full replacement
 * makes that one statement rather than an invariant to re-derive after every
 * partial edit.
 */
export async function replaceClaimLines(
  env: ClaimsEnv,
  tenantId: string,
  claimId: string,
  lineInputs: readonly ClaimLineInput[],
): Promise<ClaimDetail> {
  const claim = await getClaim(env.DB, tenantId, claimId);
  if (!claim) throw new ClaimsError("not_found", "claim not found", 404);
  assertEditable(claim);

  const lines = await resolveLines(env.DB, tenantId, lineInputs);
  const totals = totalsOf(lines);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM expense_claim_lines WHERE tenant_id = ? AND claim_id = ?").bind(
      tenantId,
      claimId,
    ),
    ...lineInsertStatements(env.DB, tenantId, claimId, lines),
    env.DB.prepare(
      `UPDATE expense_claims SET total_cents = ?, tax_cents = ?, updated_at = ?
        WHERE tenant_id = ? AND claim_id = ?`,
    ).bind(totals.total_cents, totals.tax_cents, new Date().toISOString(), tenantId, claimId),
  ]);

  return (await getClaimDetail(env.DB, tenantId, claimId))!;
}

/**
 * Submit for approval.
 *
 * Re-validates the lines rather than trusting what is stored: a receipt can be
 * deleted, a category archived or a project removed between drafting and
 * submitting, and PRD-006's "a claim without a receipt is rejected" has to hold
 * at the moment somebody is asked to decide, not at the moment the draft was
 * typed.
 *
 * From `rejected` this is a **resubmission**: it creates a NEW `approvals` row
 * and the rejected one stands (SESSION-PLAN C8), which is why no idempotency key
 * is derived from the claim id alone.
 */
export async function submitClaim(
  env: ClaimsEnv,
  tenantId: string,
  claimId: string,
  actorUserId: string | null,
): Promise<ClaimDetail> {
  const claim = await getClaim(env.DB, tenantId, claimId);
  if (!claim) throw new ClaimsError("not_found", "claim not found", 404);
  assertClaimTransition(claim, "submitted");

  const stored = await getClaimLines(env.DB, tenantId, claimId);
  if (stored.length === 0) {
    throw new ClaimsError("invalid_request", "a claim needs at least one line to submit", 422);
  }
  const missingReceipt = stored.find((line) => !line.receipt_file_id);
  if (missingReceipt) {
    throw new ClaimsError(
      "invalid_request",
      `line ${missingReceipt.line_no} has no receipt: every claim line needs one`,
      422,
    );
  }
  await assertReceipts(
    env.DB,
    tenantId,
    stored.map((line) => line.receipt_file_id),
  );

  const total = stored.reduce((sum, line) => sum + line.amount_cents, 0);
  const tax = stored.reduce((sum, line) => sum + line.tax_cents, 0);

  // Resolution happens inside requestApproval and can fail with 422 no_approver;
  // it runs BEFORE the claim's status moves, so a tenant with nobody to approve
  // is left with an editable draft rather than a claim stuck in `submitted`.
  const approval = await requestApproval(env, tenantId, {
    subject_type: "expense_claim",
    subject_id: claimId,
    requested_by: actorUserId,
    // The claim's employee, not the caller: an admin filing on somebody's behalf
    // must route to THAT employee's manager. This is the case S3 built
    // `subject_employee_id` for.
    subject_employee_id: claim.employee_id,
  });

  const submittedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE expense_claims
        SET status = 'submitted', submitted_by = ?, submitted_at = ?, approval_id = ?,
            total_cents = ?, tax_cents = ?,
            rejection_comment = NULL, rejected_at = NULL, updated_at = ?
      WHERE tenant_id = ? AND claim_id = ? AND status IN ('draft', 'rejected')`,
  )
    .bind(
      actorUserId,
      submittedAt,
      approval.approval_id,
      total,
      tax,
      submittedAt,
      tenantId,
      claimId,
    )
    .run();

  const warnings = await getClaimLimitWarnings(env.DB, tenantId, claimId);
  await env.EVENTS.send(
    makeEnvelope({
      event_type: "claim.submitted",
      source_module: "people",
      tenant_id: tenantId,
      payload: {
        claim_id: claimId,
        employee_id: claim.employee_id,
        submitted_by: actorUserId,
        approval_id: approval.approval_id,
        total_cents: total,
        tax_cents: tax,
        currency: claim.currency,
        claim_date: claim.claim_date,
        line_count: stored.length,
        project_id: claim.project_id,
        department_code: claim.department_code,
        over_limit: warnings.length > 0,
      },
    }),
  );

  return (await getClaimDetail(env.DB, tenantId, claimId))!;
}

/**
 * Withdraw a submitted claim back to `draft`.
 *
 * Cancels the pending approval through the primitive, which is what makes
 * PRD-000's "a cancelled subject no longer appears in pending lists" true for
 * claims. Cancellation is deliberately not a decision, so no `approval.*` event
 * fires and the approver is not told about work that has evaporated.
 */
export async function withdrawClaim(
  env: ClaimsEnv,
  tenantId: string,
  claimId: string,
): Promise<ClaimDetail> {
  const claim = await getClaim(env.DB, tenantId, claimId);
  if (!claim) throw new ClaimsError("not_found", "claim not found", 404);
  assertClaimTransition(claim, "draft");

  await cancelForSubject(env, tenantId, "expense_claim", claimId);
  await env.DB.prepare(
    `UPDATE expense_claims SET status = 'draft', approval_id = NULL, updated_at = ?
      WHERE tenant_id = ? AND claim_id = ? AND status = 'submitted'`,
  )
    .bind(new Date().toISOString(), tenantId, claimId)
    .run();

  return (await getClaimDetail(env.DB, tenantId, claimId))!;
}

/** Abandon a draft or rejected claim. Soft — the row and its lines stay for audit. */
export async function cancelClaim(
  env: ClaimsEnv,
  tenantId: string,
  claimId: string,
): Promise<ClaimDetail> {
  const claim = await getClaim(env.DB, tenantId, claimId);
  if (!claim) throw new ClaimsError("not_found", "claim not found", 404);
  assertClaimTransition(claim, "cancelled");

  await env.DB.prepare(
    `UPDATE expense_claims SET status = 'cancelled', updated_at = ?
      WHERE tenant_id = ? AND claim_id = ? AND status IN ('draft', 'rejected')`,
  )
    .bind(new Date().toISOString(), tenantId, claimId)
    .run();

  return (await getClaimDetail(env.DB, tenantId, claimId))!;
}

export interface ReimburseInput {
  /** Defaults to today. */
  paid_on?: string;
  payment_reference?: string | null;
}

/**
 * Record the reimbursement: `Dr Employee Reimbursements Payable / Cr Cash`, the
 * claim's `paid` status and its payment reference, all in one batch.
 *
 * Same atomicity reasoning as the approval posting — a claim marked `paid` whose
 * cash never left the books would misstate both the liability and the bank.
 */
export async function reimburseClaim(
  env: ClaimsEnv,
  tenantId: string,
  claimId: string,
  input: ReimburseInput = {},
): Promise<ClaimDetail> {
  const claim = await getClaim(env.DB, tenantId, claimId);
  if (!claim) throw new ClaimsError("not_found", "claim not found", 404);
  assertClaimTransition(claim, "paid");

  const paidOn = input.paid_on ?? new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(paidOn)) {
    throw new ClaimsError("invalid_request", "paid_on must be YYYY-MM-DD", 400);
  }
  const paidAt = new Date().toISOString();
  const posting = await buildClaimPaymentPosting(env.DB, tenantId, claim, paidOn);

  await env.DB.batch([
    ...posting.statements,
    env.DB.prepare(
      `UPDATE expense_claims
          SET status = 'paid', paid_entry_id = ?, payment_reference = ?, paid_at = ?, updated_at = ?
        WHERE tenant_id = ? AND claim_id = ? AND status = 'approved'`,
    ).bind(
      posting.entry_id,
      input.payment_reference ?? null,
      paidAt,
      paidAt,
      tenantId,
      claimId,
    ),
  ]);

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "claim.paid",
      source_module: "people",
      tenant_id: tenantId,
      payload: {
        claim_id: claimId,
        employee_id: claim.employee_id,
        total_cents: claim.total_cents,
        currency: claim.currency,
        paid_at: paidAt,
        entry_id: posting.entry_id,
        ...(input.payment_reference ? { payment_reference: input.payment_reference } : {}),
      },
    }),
  );

  return (await getClaimDetail(env.DB, tenantId, claimId))!;
}
