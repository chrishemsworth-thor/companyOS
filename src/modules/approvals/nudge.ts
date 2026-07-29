import { makeEnvelope } from "../../schemas/envelope";
import { ApprovalsError, getApproval } from "./service";

/**
 * The nudge (PRD-007 § "Requester visibility").
 *
 * A requester watching their own pending request can chase the approver. That is
 * a notification, and PRD-000 says only the event consumer writes notification
 * rows — so this emits `approval.nudged` and S4's consumer turns it into the
 * approver's badge. SESSION-PLAN conflict C4 in full.
 *
 * Lives beside the approvals service rather than inside it because it is
 * PRD-007's rule about a console affordance, not part of the primitive's
 * lifecycle: nudging does not change `state` and leaves no trace on the
 * `approvals` row.
 */

/** PRD-007: "a second nudge within 24h is blocked." */
export const NUDGE_COOLDOWN_HOURS = 24;
const NUDGE_COOLDOWN_MS = NUDGE_COOLDOWN_HOURS * 60 * 60 * 1000;

interface NudgeEnv {
  DB: D1Database;
  EVENTS: Queue;
}

export interface NudgeResult {
  approval_id: string;
  nudged_at: string;
  /** Who was reminded, so the console can say "we reminded them". */
  approver_user_id: string;
}

/**
 * A `429` carrying how long the caller must wait. Its own error type rather than
 * an `ApprovalsError` code, because 429 is outside that class's status union and
 * widening it would let every approvals route return one.
 */
export class NudgeRateLimited extends Error {
  readonly code = "rate_limited";
  readonly httpStatus = 429 as const;
  constructor(
    readonly retryAfterSeconds: number,
    readonly lastNudgedAt: string,
  ) {
    super(
      `this request was already nudged less than ${NUDGE_COOLDOWN_HOURS}h ago ` +
        `(at ${lastNudgedAt}); nudging again would just be nagging`,
    );
    this.name = "NudgeRateLimited";
  }
}

/**
 * Chase the approver on a pending request.
 *
 * Order matters and is the same defensive order the approvals service uses:
 *
 *  1. **Existence**, tenant-scoped — another tenant's id is a 404, never a 403.
 *  2. **Authorization** — the requester only. Not an admin override: nudging is
 *     "chase my own request", and an admin who wants to move a request along can
 *     simply decide it.
 *  3. **State** — only a pending request can be chased. Learning the state comes
 *     after authorization, so an unauthorized caller learns nothing.
 *  4. **Rate limit** — last, because it is the only check that writes.
 *
 * The ledger row is written BEFORE the emit. If the emit then fails, the caller
 * has burned their cooldown and no reminder went out, which is mildly annoying;
 * the other order risks a caller who retries a failed response nudging twice.
 * Annoying beats duplicated, and on the free plan `send()` resolves even when the
 * consumer fails, so this window is very nearly theoretical.
 */
export async function nudge(
  env: NudgeEnv,
  tenantId: string,
  approvalId: string,
  nudgedBy: string,
): Promise<NudgeResult> {
  const approval = await getApproval(env.DB, tenantId, approvalId);
  if (!approval) throw new ApprovalsError("not_found", "approval not found", 404);

  if (approval.requested_by !== nudgedBy) {
    throw new ApprovalsError(
      "forbidden",
      "only the requester may nudge this request",
      403,
    );
  }
  if (approval.state !== "pending") {
    throw new ApprovalsError(
      "illegal_transition",
      `approval is ${approval.state} and needs no reminder`,
      409,
    );
  }

  const now = new Date();
  const last = await env.DB.prepare(
    `SELECT nudged_at FROM approval_nudges
     WHERE tenant_id = ? AND approval_id = ?
     ORDER BY nudged_at DESC LIMIT 1`,
  )
    .bind(tenantId, approvalId)
    .first<{ nudged_at: string }>();

  if (last) {
    const elapsedMs = now.getTime() - new Date(last.nudged_at).getTime();
    if (elapsedMs < NUDGE_COOLDOWN_MS) {
      throw new NudgeRateLimited(
        Math.ceil((NUDGE_COOLDOWN_MS - elapsedMs) / 1000),
        last.nudged_at,
      );
    }
  }

  const nudgedAt = now.toISOString();
  await env.DB.prepare(
    "INSERT INTO approval_nudges (tenant_id, approval_id, nudged_by, nudged_at) VALUES (?, ?, ?, ?)",
  )
    .bind(tenantId, approvalId, nudgedBy, nudgedAt)
    .run();

  const pendingHours = Math.max(
    0,
    (now.getTime() - new Date(approval.created_at).getTime()) / (60 * 60 * 1000),
  );

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "approval.nudged",
      source_module: "platform",
      tenant_id: tenantId,
      payload: {
        approval_id: approvalId,
        subject_type: approval.subject_type,
        subject_id: approval.subject_id,
        requested_by: nudgedBy,
        approver_user_id: approval.approver_user_id,
        pending_hours: Math.round(pendingHours * 10) / 10,
      },
    }),
  );

  return {
    approval_id: approvalId,
    nudged_at: nudgedAt,
    approver_user_id: approval.approver_user_id,
  };
}
