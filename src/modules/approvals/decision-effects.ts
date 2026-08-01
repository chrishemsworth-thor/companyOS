import type { EventEnvelope } from "../../schemas/envelope";
import { applyClaimDecision, type ClaimDecisionContext } from "../claims/decision";
import type { Approval, SubjectType } from "./types";

/**
 * Per-`subject_type` decision effects (added by S5, PRD-006a).
 *
 * The problem this solves is atomicity. PRD-006 requires that approving a claim
 * and posting its journal entry are atomic — "no approved claim without its
 * entry" — and no event consumer can deliver that: on the paid plan the consumer
 * runs after the decision has committed, and on the free plan
 * src/queue/direct.ts catches a throwing consumer, logs it and drops it. Either
 * way the business write is already durable and there is nothing to roll back.
 *
 * So a subject module may contribute **statements** to the same `db.batch()` that
 * records the decision. D1 runs a batch as one transaction, which is the
 * mechanism `createInvoice` and `recordPayment` already use to post a journal
 * entry atomically with their own rows.
 *
 * This is a pluggable table in exactly the shape `SUBJECT_STRATEGIES` in
 * `resolution.ts` already has, and it keeps the primitive's promises intact:
 *
 *  - **No second approvals mechanism.** There is no module-local approval table
 *    and no module-local decision route; the console still calls
 *    `POST /v1/approvals/:id/approve`.
 *  - **The hook lives in the service, not the route**, so a programmatic
 *    `decide()` caller gets the same guarantee as a human clicking Approve.
 *  - **An effect that throws writes nothing at all** — not the decision, not the
 *    claim, not the entry. That is the atomicity criterion in both directions.
 *
 * Adding one for a new subject type is a line here plus one function in the
 * consuming module. S7's leave balance deduction is the next one.
 *
 * **Import direction matters.** This file imports the consuming module; the
 * consuming module's effect file must not import `./service`. Today:
 * `service.ts` -> `decision-effects.ts` -> `claims/decision.ts` ->
 * `{claims/repo, claims/posting, schemas/envelope}`, while `claims/service.ts`
 * imports `service.ts`. No cycle.
 */

/** The decision as it is about to be written — see `ClaimDecisionContext`. */
export type DecisionContext = ClaimDecisionContext;

export interface DecisionOutcome {
  /** Run in the same batch as the `approvals` UPDATE. */
  statements: D1PreparedStatement[];
  /** Emitted after the batch commits, alongside the `approval.*` event. */
  events: EventEnvelope[];
}

export type DecisionEffect = (
  env: { DB: D1Database },
  tenantId: string,
  approval: Approval,
  ctx: DecisionContext,
) => Promise<DecisionOutcome>;

/**
 * Subject types with a decision effect. Absent means "the decision is the whole
 * story", which is true of `quote`, `invoice` and `other`.
 */
export const SUBJECT_DECISION_EFFECTS: Partial<Record<SubjectType, DecisionEffect>> = {
  expense_claim: applyClaimDecision,
};

/** The effect for a subject type, if it has one. Never throws on an unknown value. */
export function decisionEffectFor(subjectType: string): DecisionEffect | undefined {
  return SUBJECT_DECISION_EFFECTS[subjectType as SubjectType];
}

/** Statuses a decision effect may ask the approvals route to return. */
const EFFECT_ERROR_STATUSES = new Set([400, 403, 404, 409, 422]);

/**
 * An effect refused the decision, and the approver needs to know why.
 *
 * When an effect throws, the batch never runs — which is the atomicity guarantee
 * — but the approver still has to be told what to fix. "Approve" returning an
 * opaque 500 for an archived expense account would leave them clicking a button
 * that will never work with no idea why.
 *
 * Recognised **structurally** rather than by importing the consuming module's
 * error class. Every error class in this codebase already carries the same shape
 * (`SupportError`, `FilesError`, `ApprovalsError`, `ClaimsError`), and matching on
 * the shape is what keeps the primitive from having to know which modules
 * register effects. The status allowlist is what stops an unrelated exception with
 * a stray `httpStatus` from being reported as a client error.
 */
export function isDecisionEffectError(
  err: unknown,
): err is { code: string; message: string; httpStatus: 400 | 403 | 404 | 409 | 422 } {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: unknown; message?: unknown; httpStatus?: unknown };
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.httpStatus === "number" &&
    EFFECT_ERROR_STATUSES.has(candidate.httpStatus)
  );
}
