import { makeEnvelope, type EventEnvelope } from "../../schemas/envelope";
import type { Approval } from "../approvals/types";
import { buildClaimApprovalPosting } from "./posting";
import { getClaim, getClaimLines } from "./repo";

/**
 * What happens to a claim when its approval is decided (PRD-006a).
 *
 * This file is the answer to the load-bearing acceptance criterion:
 *
 *   > Given claim approval, then the posting and the approval decision are
 *   > atomic (no approved claim without its entry).
 *
 * It cannot be a consumer of `approval.approved`. On the paid plan the queue
 * consumer runs after the decision has committed; on the free plan
 * src/queue/direct.ts catches a throwing consumer, logs it and **drops** it. Both
 * leave a decided approval with no journal entry and nothing to roll back.
 *
 * So instead this returns **statements**, which
 * `src/modules/approvals/service.ts` runs in the same `db.batch()` as the
 * `approvals` UPDATE — one D1 transaction covering the decision, the claim's
 * status and the ledger entry. If anything here throws, the batch never runs: the
 * approval stays `pending`, the claim stays `submitted`, and the approver gets a
 * message they can act on.
 *
 * **This file must not import from `../approvals/service`** (only its
 * dependency-free `types`). The approvals service imports the effect registry,
 * which imports this — anything else would be a cycle.
 */

/**
 * The decision as it is about to be written, which is not what the `approvals`
 * row says yet.
 *
 * The effect runs *before* the batch, so the row the service read still has
 * `decided_by` / `decision_comment` NULL. The comment in particular is
 * load-bearing — it is the "why" a rejected claim carries back to the employee —
 * so it travels here explicitly rather than being read from a row that has not
 * been updated.
 */
export interface ClaimDecisionContext {
  decision: "approved" | "rejected";
  comment: string | null;
  decided_by: string;
  decided_at: string;
}

/**
 * A decision on a claim whose row has gone missing or moved on is a no-op, not an
 * error.
 *
 * Throwing would wedge the approver's inbox: a row they cannot decide, cannot
 * cancel (cancelling a decided approval is a 409) and cannot clear. Returning
 * nothing is safe because the invariant runs one way — the claim is only ever
 * marked `approved` by the same batch that writes its entry, so "no approved
 * claim without its entry" still holds. The log line is how the inconsistency
 * gets found.
 */
function skip(reason: string, approval: Approval): { statements: never[]; events: never[] } {
  console.warn(
    `[claims] approval ${approval.approval_id} decided but its claim ${approval.subject_id} ${reason}: no claim change, no posting`,
  );
  return { statements: [], events: [] };
}

/**
 * The `expense_claim` decision effect, registered in
 * src/modules/approvals/decision-effects.ts.
 *
 * On **approve**: post `Dr {category expense} / Cr Employee Reimbursements
 * Payable` and mark the claim `approved` with its `entry_id`.
 *
 * On **reject**: mark the claim `rejected` and store the comment. No entry is
 * written, which is PRD-006's "given a rejected claim, then no ledger entry
 * exists" — satisfied structurally rather than by a check.
 */
export async function applyClaimDecision(
  env: { DB: D1Database },
  tenantId: string,
  approval: Approval,
  ctx: ClaimDecisionContext,
): Promise<{ statements: D1PreparedStatement[]; events: EventEnvelope[] }> {
  const claim = await getClaim(env.DB, tenantId, approval.subject_id);
  if (!claim) return skip("does not exist", approval);
  if (claim.status !== "submitted") return skip(`is ${claim.status}, not submitted`, approval);

  if (ctx.decision === "rejected") {
    return {
      statements: [
        env.DB.prepare(
          `UPDATE expense_claims
              SET status = 'rejected', rejection_comment = ?, rejected_at = ?,
                  approval_id = ?, updated_at = ?
            WHERE tenant_id = ? AND claim_id = ? AND status = 'submitted'`,
        ).bind(
          ctx.comment,
          ctx.decided_at,
          approval.approval_id,
          ctx.decided_at,
          tenantId,
          claim.claim_id,
        ),
      ],
      events: [
        makeEnvelope({
          event_type: "claim.rejected",
          source_module: "people",
          tenant_id: tenantId,
          payload: {
            claim_id: claim.claim_id,
            employee_id: claim.employee_id,
            approval_id: approval.approval_id,
            decided_by: ctx.decided_by,
            decided_at: ctx.decided_at,
            ...(ctx.comment ? { comment: ctx.comment } : {}),
          },
        }),
      ],
    };
  }

  const lines = await getClaimLines(env.DB, tenantId, claim.claim_id);
  // Throws ClaimsError on anything unpostable (no lines, header/line mismatch, an
  // archived category account). The throw propagates out of `decide()` before the
  // batch, so nothing is written at all.
  const posting = await buildClaimApprovalPosting(env.DB, tenantId, claim, lines);

  return {
    statements: [
      ...posting.statements,
      env.DB.prepare(
        `UPDATE expense_claims
            SET status = 'approved', entry_id = ?, approval_id = ?,
                rejection_comment = NULL, rejected_at = NULL, updated_at = ?
          WHERE tenant_id = ? AND claim_id = ? AND status = 'submitted'`,
      ).bind(posting.entry_id, approval.approval_id, ctx.decided_at, tenantId, claim.claim_id),
    ],
    events: [
      makeEnvelope({
        event_type: "claim.approved",
        source_module: "people",
        tenant_id: tenantId,
        payload: {
          claim_id: claim.claim_id,
          employee_id: claim.employee_id,
          approval_id: approval.approval_id,
          decided_by: ctx.decided_by,
          decided_at: ctx.decided_at,
          total_cents: posting.total_cents,
          currency: claim.currency,
          // The whole point of the event: a downstream consumer can go straight
          // to the journal entry without re-deriving which one it was.
          entry_id: posting.entry_id,
        },
      }),
    ],
  };
}
