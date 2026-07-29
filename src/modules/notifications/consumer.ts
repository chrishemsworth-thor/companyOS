import type { EventEnvelope } from "../../schemas/envelope";
import { createNotifications } from "./service";
import { subjectTypeLabel, type NotificationSpec } from "./types";

/**
 * The event→notification consumer (PRD-000c).
 *
 * PRD-000 requires notification rows be created by an event consumer, never by
 * module code, and `NOTIFICATION_MAP` below is that consumer. **Adding a
 * notification type means adding one entry to that map** — it is the designed
 * extension point, and the reason standing rule 2 forbids a module inventing its
 * own notification mechanism. S11 registers `ticket.assigned`, S14 registers
 * `project.deadline_approaching` and `project.overdue`, and neither needs to
 * touch anything else here.
 *
 * ## Why nothing in this file throws
 *
 * On a free-plan deploy there is no queue: events dispatch inline through
 * src/queue/direct.ts, which catches, logs and DROPS a throwing consumer. The
 * business write that emitted the event has already committed, so a throw
 * cannot roll anything back — it just loses the notification *and*, on the queue
 * path, forces a retry of the whole envelope including agent routing. Neither
 * helps.
 *
 * So the contract is: compose what the payload supports, write it idempotently,
 * and log anything that goes wrong. A malformed payload produces no rows rather
 * than an exception, and a redelivered event produces no *second* row rather
 * than a duplicate badge. See the resolved free-plan question in
 * docs/prd/SESSION-PLAN.md.
 */

/** A string field off an event payload, or null when absent/blank/not a string. */
function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The subject fields every `approval.*` payload shares. Returns null if any is
 * missing, which is the non-throwing skip: an event that cannot say what it is
 * about produces no notification.
 */
function approvalSubject(
  payload: Record<string, unknown>,
): { approval_id: string; subject_type: string; subject_id: string } | null {
  const approvalId = str(payload, "approval_id");
  const subjectType = str(payload, "subject_type");
  const subjectId = str(payload, "subject_id");
  if (!approvalId || !subjectType || !subjectId) return null;
  return { approval_id: approvalId, subject_type: subjectType, subject_id: subjectId };
}

/**
 * event_type → the notifications it produces.
 *
 * Takes the whole envelope, not just the payload, because a dedupe key
 * sometimes needs `event_id` (see `approval.nudged`).
 *
 * A mapper returns `[]` rather than throwing when the payload does not carry
 * what it needs — including when the person to notify is not a user at all.
 * `approvals.requested_by` is nullable: a claim raised by a tenant API key has
 * no human requester, so there is nobody to tell about the decision, and that is
 * a normal outcome rather than an error.
 */
const NOTIFICATION_MAP: Record<string, (envelope: EventEnvelope) => NotificationSpec[]> = {
  /** Somebody owes a decision → tell the approver. */
  "approval.requested": (envelope) => {
    const subject = approvalSubject(envelope.payload);
    if (!subject) return [];
    const approver = str(envelope.payload, "approver_user_id");
    if (!approver) return [];
    return [
      {
        user_id: approver,
        subject_type: subject.subject_type,
        subject_id: subject.subject_id,
        title: `Approval needed: ${subjectTypeLabel(subject.subject_type)}`,
        dedupe_key: `approval.requested:${subject.approval_id}`,
      },
    ];
  },

  /** A decision landed → tell whoever asked. */
  "approval.approved": (envelope) => decisionNotification(envelope, "Approved"),
  "approval.rejected": (envelope) => decisionNotification(envelope, "Rejected"),

  /**
   * The requester chased their approver (PRD-007, via C4) → tell the approver
   * again.
   *
   * Deduped on `event_id`, not on `approval_id`: a nudge is a repeatable act, so
   * keying on the approval would silently swallow a legitimate second nudge a
   * day later. `event_id` is stable across redelivery of the *same* nudge and
   * distinct across different ones, which is exactly the required semantics. The
   * 24h rate limit is enforced upstream in the service, before the emit.
   */
  "approval.nudged": (envelope) => {
    const subject = approvalSubject(envelope.payload);
    if (!subject) return [];
    const approver = str(envelope.payload, "approver_user_id");
    if (!approver) return [];
    return [
      {
        user_id: approver,
        subject_type: subject.subject_type,
        subject_id: subject.subject_id,
        title: `Reminder: ${subjectTypeLabel(subject.subject_type)} is still waiting for you`,
        dedupe_key: `approval.nudged:${envelope.event_id}`,
      },
    ];
  },
};

/**
 * Shared shape of the two decision events. The decision comment becomes the
 * body — it is the one thing on the payload the destination screen may not put
 * in front of the requester, and "why was this rejected" is the whole reason
 * they opened the notification.
 */
function decisionNotification(
  envelope: EventEnvelope,
  verb: "Approved" | "Rejected",
): NotificationSpec[] {
  const subject = approvalSubject(envelope.payload);
  if (!subject) return [];
  const requester = str(envelope.payload, "requested_by");
  if (!requester) return [];
  const eventType = verb === "Approved" ? "approval.approved" : "approval.rejected";
  return [
    {
      user_id: requester,
      subject_type: subject.subject_type,
      subject_id: subject.subject_id,
      title: `${verb}: your ${subjectTypeLabel(subject.subject_type)}`,
      body: str(envelope.payload, "comment"),
      dedupe_key: `${eventType}:${subject.approval_id}`,
    },
  ];
}

/** Event types this consumer notifies on. Exported for the module's own tests. */
export function notifiableEventTypes(): string[] {
  return Object.keys(NOTIFICATION_MAP);
}

/**
 * Turn one event into notification rows.
 *
 * Called by `processEvent` for every event on the bus; events with no entry in
 * the map are a no-op, which is the overwhelming majority of them. Never throws
 * — see the file comment.
 */
export async function fanoutNotifications(
  env: { DB: D1Database },
  envelope: EventEnvelope,
): Promise<void> {
  const mapper = NOTIFICATION_MAP[envelope.event_type];
  if (!mapper) return;

  try {
    const specs = mapper(envelope);
    if (specs.length === 0) {
      console.warn(
        `[notifications] ${envelope.event_type} ${envelope.event_id} produced no notification: ` +
          `payload is missing a recipient or subject`,
      );
      return;
    }
    const inserted = await createNotifications(
      env.DB,
      envelope.tenant_id,
      envelope.event_type,
      specs,
    );
    if (inserted < specs.length) {
      // Not an error: the natural key did its job on a redelivered event.
      console.log(
        `[notifications] ${envelope.event_type} ${envelope.event_id}: ` +
          `${inserted}/${specs.length} rows written, rest already existed`,
      );
    }
  } catch (err) {
    // The emitting write has already committed and the inline path has no retry,
    // so there is nothing to do but say so loudly. Swallowing here also keeps a
    // notification failure from retrying agent routing on the queue path.
    console.error(
      `[notifications] fanout failed for ${envelope.event_type} ${envelope.event_id}: ${String(err)}`,
    );
  }
}
