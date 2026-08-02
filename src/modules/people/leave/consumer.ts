import type { EventEnvelope } from "../../../schemas/envelope";
import { applyApprovalDecision, emitDecision } from "./service";

/**
 * The `approval.*` → leave-request state consumer (PRD-006c).
 *
 * ## Why a consumer and not a hook in the approvals service
 *
 * Standing rule 2: a module does not invent an approvals mechanism, and the
 * approvals primitive does not learn about leave. So the decision reaches this
 * module the same way it reaches notifications — off the bus, dispatching on
 * `subject_type`. Adding the claims equivalent in S5 is another function beside
 * this one and one line in `processEvent`; neither touches
 * src/modules/approvals/.
 *
 * ## Why that is safe here, and would not be for claims
 *
 * The free-plan inline bus has no retry: `src/queue/direct.ts` catches, logs and
 * DROPS a throwing consumer, and the write that emitted the event has already
 * committed. For notifications a drop costs a badge. Here it would cost a state
 * transition — an `approved` approval whose leave request still reads `pending`.
 *
 * Three things make that acceptable rather than merely tolerated:
 *
 *  1. **Nothing is lost but a label.** Balance is derived, and `pending` and
 *     `approved` both consume it (see the service's file comment), so a missed
 *     transition cannot corrupt anybody's balance. This is precisely the
 *     guarantee S5's ledger posting will NOT have, which is why claims need
 *     atomicity with the decision and leave does not.
 *  2. **On the inline path the update is awaited inside the decide request.**
 *     `direct.ts` awaits `processEvent`, so the flip happens before the approver's
 *     HTTP response returns. It is not deferred work that might never run.
 *  3. **On the queue path a throw retries into the DLQ.** So the one genuinely
 *     lossy combination is a throwing update on the inline path, and the update
 *     is a single idempotent statement guarded on the state it expects.
 *
 * Like `fanoutNotifications`, nothing here throws.
 */

interface ConsumerEnv {
  DB: D1Database;
  EVENTS: Queue;
}

/** A string field off a payload, or null when absent/blank/not a string. */
function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Event types this consumer acts on. Exported for the module's own tests. */
export function leaveDecisionEventTypes(): string[] {
  return ["approval.approved", "approval.rejected"];
}

/**
 * Move a leave request to match its approval's decision, and emit the module's
 * own `leave.*` event.
 *
 * Two events come out of one decision and that is deliberate: `approval.approved`
 * is the primitive's audit fact and is what notifies the requester (S4's
 * consumer), while `leave.approved` is the domain fact a future PeopleAgent or
 * calendar feed subscribes to. Neither substitutes for the other, and PRD-006
 * lists the `leave.*` four as required events in their own right.
 *
 * The emit is gated on the transition actually having happened, so a redelivered
 * approval event produces no second `leave.approved`.
 */
export async function applyLeaveDecision(
  env: ConsumerEnv,
  envelope: EventEnvelope,
): Promise<void> {
  if (!leaveDecisionEventTypes().includes(envelope.event_type)) return;
  if (str(envelope.payload, "subject_type") !== "leave_request") return;

  const leaveRequestId = str(envelope.payload, "subject_id");
  if (!leaveRequestId) return;

  const decision = envelope.event_type === "approval.approved" ? "approved" : "rejected";
  const decidedAt = str(envelope.payload, "decided_at") ?? envelope.occurred_at;
  const decidedBy = str(envelope.payload, "decided_by");
  const comment = str(envelope.payload, "comment");

  try {
    const transition = await applyApprovalDecision(
      env.DB,
      envelope.tenant_id,
      leaveRequestId,
      decision,
      decidedAt,
    );
    // Null means there was nothing to do: an unknown subject id, an already
    // terminal request, or a redelivery that lost the guarded UPDATE. All three
    // are normal, and none of them should emit.
    if (!transition) return;

    await emitDecision(
      env,
      envelope.tenant_id,
      leaveRequestId,
      transition,
      decidedBy,
      decidedAt,
      comment,
    );
  } catch (err) {
    // The decision has already committed and the inline path has no retry, so
    // there is nothing to do but say so loudly. Swallowing also keeps a leave
    // failure from retrying notification fanout and agent routing alongside it.
    console.error(
      `[leave] failed to apply ${envelope.event_type} ${envelope.event_id} ` +
        `to ${leaveRequestId}: ${String(err)}`,
    );
  }
}
