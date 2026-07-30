import { buildEntryStatements, getAccountByCode } from "../finance/ledger";
import { getClaimCategoriesByIds, CASH_CODE, REIMBURSEMENTS_PAYABLE_CODE } from "./categories";
import { ClaimsError } from "./errors";
import type { ExpenseClaim, ExpenseClaimLine } from "./types";

/**
 * Claim -> GL posting (PRD-006a, "the differentiating requirement").
 *
 * Both builders return **statements rather than running them**, in the same
 * shape as `buildEntryStatements` in src/modules/finance/ledger.ts. That is what
 * makes PRD-006's atomicity criterion achievable: the caller puts the entry, the
 * claim's own status change and (on approval) the `approvals` row update into a
 * single `db.batch()`, which D1 executes as one transaction. There is no window
 * in which an approved claim exists without its entry.
 *
 * ============================================================================
 * THE MISSING THIRD LEG
 * ============================================================================
 *
 * PRD-006 specifies `Dr {category expense} / Dr SST Input (if applicable) / Cr
 * Employee Reimbursements Payable`. `SST Input` belongs to PRD-001's tax work,
 * which is S12 and lands after this session (SESSION-PLAN conflict C2). This
 * session posts the two-leg entry and **does not invent an SST account**.
 *
 * That is not a rounding-off of the requirement: for a tenant that is not
 * SST-registered the input tax is unrecoverable and genuinely *is* part of the
 * expense, so debiting the gross amount to the category account is the correct
 * entry, not an approximation of one. `expense_claim_lines.tax_cents` is
 * captured on every line regardless.
 *
 * **S12's change here is precise:** for an SST-registered tenant, reduce each
 * expense debit from `amount_cents` to `amount_cents - tax_cents` and add one
 * `Dr SST Input` line for the summed tax. The credit leg does not move — the
 * employee is still owed the gross. Nothing else in this file changes.
 */

/**
 * `journal_entries.source_type` is constrained to
 * ('invoice','payment','manual','reversal') by a SQL CHECK, and extending it
 * needs a table rebuild the append-only triggers on `journal_lines` make
 * unavailable — see the long note in migrations/0024_expense_claims.sql.
 *
 * So claim postings are `manual` and lean on `source_id`, which carries the
 * typed `clm_` prefix: "this claim's entry" is one indexed lookup and "every
 * claim posting" is `source_id LIKE 'clm_%'`. S12/S13 touch finance anyway and
 * can spend one reviewed rebuild on the whole vocabulary.
 */
const CLAIM_SOURCE_TYPE = "manual" as const;

/**
 * The department a line's expense is attributed to: the line's own override, else
 * the claim's, else the employee's home department.
 *
 * Falling back to the employee's department rather than leaving it NULL is
 * deliberate. PRD-001a's profitability rollup shows untagged spend in an
 * explicit "Unallocated" bucket, and an expense claim is the one case where the
 * correct department is never actually unknown — somebody's salary line already
 * says which team they are on.
 */
async function resolveEmployeeDepartment(
  db: D1Database,
  tenantId: string,
  employeeId: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT department_id FROM employees WHERE tenant_id = ? AND employee_id = ?")
    .bind(tenantId, employeeId)
    .first<{ department_id: string }>();
  return row?.department_id ?? null;
}

/**
 * Build the approval posting:
 *
 *   Dr {category expense account}   line.amount_cents   (one line per claim line)
 *   Cr 2100 Employee Reimbursements Payable   -(total)
 *
 * Dimensions on every expense line: `employee_id` (whose claim it is),
 * `project_id` (line override, else the claim's) and `department_code` (line,
 * else claim, else the employee's own). The payable leg carries `employee_id`
 * only — it is a balance-sheet account, so it never reaches the profitability
 * rollup (which filters on `type IN ('revenue','expense')`), and "who are we out
 * of pocket to" is the one question it needs to answer.
 */
export async function buildClaimApprovalPosting(
  db: D1Database,
  tenantId: string,
  claim: ExpenseClaim,
  lines: readonly ExpenseClaimLine[],
): Promise<{ entry_id: string; statements: D1PreparedStatement[]; total_cents: number }> {
  if (lines.length === 0) {
    throw new ClaimsError("unpostable", "a claim with no lines cannot be posted", 422);
  }

  const total = lines.reduce((sum, line) => sum + line.amount_cents, 0);
  if (total !== claim.total_cents) {
    // Belt for a bug rather than a user error: the service maintains the header
    // total from the lines, so a mismatch means something wrote around it.
    // Refusing to post is right — a claim whose header and lines disagree would
    // put a number in the ledger that no document supports.
    throw new ClaimsError(
      "unpostable",
      `claim total ${claim.total_cents} does not match its lines (${total})`,
      422,
    );
  }

  const categories = await getClaimCategoriesByIds(
    db,
    tenantId,
    lines.map((line) => line.category_id),
  );
  const payable = await getAccountByCode(db, tenantId, REIMBURSEMENTS_PAYABLE_CODE);
  const employeeDepartment = await resolveEmployeeDepartment(db, tenantId, claim.employee_id);

  const expenseLines = lines.map((line) => {
    const category = categories.get(line.category_id);
    if (!category) {
      throw new ClaimsError(
        "unpostable",
        `line ${line.line_no} names unknown claim category '${line.category_id}'`,
        422,
      );
    }
    // An archived account is the realistic version of this failure: finance
    // tidies the chart while a claim sits pending. Caught here so the approver
    // gets a message naming the account instead of a foreign-key error, and so
    // the batch never runs — which is the atomicity guarantee in the direction
    // that matters least often and hurts most.
    if (category.account_archived_at) {
      throw new ClaimsError(
        "unpostable",
        `claim category '${category.name}' posts to account ${category.account_code}, which is archived: re-map the category before approving`,
        422,
      );
    }
    return {
      account_id: category.expense_account_id,
      amount_cents: line.amount_cents,
      employee_id: claim.employee_id,
      project_id: line.project_id ?? claim.project_id ?? null,
      department_code: line.department_code ?? claim.department_code ?? employeeDepartment,
    };
  });

  const { entry_id, statements } = buildEntryStatements(db, tenantId, {
    entry_date: claim.claim_date,
    memo: `expense claim ${claim.claim_id} approved`,
    currency: claim.currency,
    source_type: CLAIM_SOURCE_TYPE,
    source_id: claim.claim_id,
    lines: [
      ...expenseLines,
      { account_id: payable.account_id, amount_cents: -total, employee_id: claim.employee_id },
    ],
  });
  return { entry_id, statements, total_cents: total };
}

/**
 * Build the reimbursement posting:
 *
 *   Dr 2100 Employee Reimbursements Payable   total
 *   Cr 1000 Cash                             -(total)
 *
 * PRD-006 records this "as a payment against the claim", which is what
 * `paid_entry_id` and `payment_reference` on the claim are for. It clears exactly
 * what the approval posting created, so the payable balance returns to zero for a
 * fully reimbursed claim — the assertion behind "payable is cleared and the claim
 * is `paid`".
 */
export async function buildClaimPaymentPosting(
  db: D1Database,
  tenantId: string,
  claim: ExpenseClaim,
  paidOn: string,
): Promise<{ entry_id: string; statements: D1PreparedStatement[] }> {
  if (claim.total_cents <= 0) {
    throw new ClaimsError("unpostable", "a claim with no value cannot be reimbursed", 422);
  }
  const payable = await getAccountByCode(db, tenantId, REIMBURSEMENTS_PAYABLE_CODE);
  const cash = await getAccountByCode(db, tenantId, CASH_CODE);

  return buildEntryStatements(db, tenantId, {
    entry_date: paidOn,
    memo: `expense claim ${claim.claim_id} reimbursed`,
    currency: claim.currency,
    source_type: CLAIM_SOURCE_TYPE,
    source_id: claim.claim_id,
    // Both legs carry the employee, so "everything we have paid Aisha" is one
    // dimension query rather than a join back through the claim.
    lines: [
      {
        account_id: payable.account_id,
        amount_cents: claim.total_cents,
        employee_id: claim.employee_id,
      },
      {
        account_id: cash.account_id,
        amount_cents: -claim.total_cents,
        employee_id: claim.employee_id,
      },
    ],
  });
}
