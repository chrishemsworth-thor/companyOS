import { makeEnvelope, type EventEnvelope } from "../../schemas/envelope";
import type { Approval } from "../approvals/types";

/**
 * What happens to a quote when its internal sign-off is decided (PRD-004 P1).
 *
 * Registered in `src/modules/approvals/decision-effects.ts` under
 * `subject_type = 'quote'`, so these statements run in the SAME `db.batch()` as
 * the `approvals` UPDATE. That matters here for the same reason it mattered for
 * S5's claim posting: if the decision could commit without the quote moving,
 * there would be a window in which an approver has said yes and the quote is
 * still parked in `pending_approval` with nothing left to trigger it.
 *
 * ## The interpretation this file takes
 *
 * PRD-004's criterion is *"given approval is granted, then the quote can be
 * sent"*. Two readings: auto-send, or return it to an editable state where a
 * second `send` now works.
 *
 * **Approval sends it.** Returning an approved quote to `draft` would let
 * somebody edit the price after sign-off and then send it unapproved — the
 * exact failure the gate exists to prevent, and one the immutability rule
 * cannot catch because a draft is legitimately editable. The operator already
 * asked to send; the approval was the gate, not a separate instruction. The
 * outcome is strictly stronger than the criterion.
 *
 * Rejection returns the quote to `draft` with the approver's comment attached,
 * matching PRD-004's "returns to draft with the comment attached" and PRD-006's
 * treatment of a rejected claim.
 *
 * **This file must not import `../approvals/service` or `./service`.** The
 * approvals service imports the effect registry, which imports this; and
 * `./service` imports the approvals service. Both would be cycles, which is why
 * the two queries below are written out rather than reusing `getQuote`.
 */

interface QuoteDecisionRow {
  quote_id: string;
  customer_id: string;
  status: string;
  quote_number: string;
}

/**
 * A decision on a quote that has moved on is a no-op, not an error.
 *
 * Throwing would wedge the approver's inbox with a row they can neither decide
 * nor cancel. Safe to skip because the invariant runs one way: a quote only
 * ever reaches `sent` through this batch or through `sendQuote`'s own guard, so
 * nothing can be sent without having passed the gate. The log line is how the
 * inconsistency gets found.
 */
function skip(reason: string, approval: Approval): { statements: never[]; events: never[] } {
  console.warn(
    `[quotes/decision] skipping effect for approval ${approval.approval_id}: ${reason}`,
  );
  return { statements: [], events: [] };
}

export interface QuoteDecisionContext {
  decision: "approved" | "rejected";
  comment: string | null;
  decided_by: string;
  decided_at: string;
}

export async function applyQuoteDecision(
  env: { DB: D1Database },
  tenantId: string,
  approval: Approval,
  ctx: QuoteDecisionContext,
): Promise<{ statements: D1PreparedStatement[]; events: EventEnvelope[] }> {
  const quote = await env.DB.prepare(
    "SELECT quote_id, customer_id, status, quote_number FROM quotes WHERE tenant_id = ? AND quote_id = ?",
  )
    .bind(tenantId, approval.subject_id)
    .first<QuoteDecisionRow>();

  if (!quote) return skip("quote no longer exists", approval);
  if (quote.status !== "pending_approval") {
    return skip(`quote is ${quote.status}, not pending_approval`, approval);
  }

  if (ctx.decision === "rejected") {
    return {
      statements: [
        env.DB.prepare(
          `UPDATE quotes
              SET status = 'draft', sign_off_comment = ?, updated_at = ?
            WHERE tenant_id = ? AND quote_id = ? AND status = 'pending_approval'`,
        ).bind(ctx.comment, ctx.decided_at, tenantId, quote.quote_id),
      ],
      // No `quote.*` event for a rejection: nothing happened to the quote from
      // the customer's or the ledger's point of view, and `approval.rejected`
      // already tells the requester, with the comment on it.
      events: [],
    };
  }

  return {
    statements: [
      env.DB.prepare(
        `UPDATE quotes
            SET status = 'sent', sent_at = ?, sign_off_comment = NULL, updated_at = ?
          WHERE tenant_id = ? AND quote_id = ? AND status = 'pending_approval'`,
      ).bind(ctx.decided_at, ctx.decided_at, tenantId, quote.quote_id),
    ],
    // Emitted after the batch commits, alongside `approval.approved`. This is
    // the same `quote.sent` an ordinary send emits — a consumer should not have
    // to know whether a sign-off was involved.
    events: [
      makeEnvelope({
        event_type: "quote.sent",
        source_module: "sales",
        tenant_id: tenantId,
        occurred_at: ctx.decided_at,
        payload: {
          quote_id: quote.quote_id,
          customer_id: quote.customer_id,
          sent_at: ctx.decided_at,
        },
      }),
    ],
  };
}
