import { z } from "zod";

/**
 * Notifications primitive (PRD-000c) — vocabulary and row shape.
 *
 * Dependency-free so the service, the consumer and the route can all import it
 * without cycles, matching src/modules/approvals/types.ts.
 */

/**
 * What a notification can point at.
 *
 * A superset of the approvals primitive's `subjectTypeSchema`: every approvable
 * subject is notifiable, but not every notifiable subject is approvable —
 * PRD-005 notifies on ticket assignment and PRD-009 on a project deadline,
 * neither of which is an approval. Kept as its own enum rather than importing
 * approvals' so notifications does not depend on the approvals module.
 *
 * Like `approvals.subject_type` and `files.purpose`, the column is plain TEXT
 * and this enum is the only thing a consuming module adds — no migration.
 * Values arrive with the session that needs them: `ticket` with S11, `project`
 * with S14.
 *
 * **This enum does not gate writes.** The consumer accepts any `subject_type`
 * off an event and stores it verbatim; a value missing from here still produces
 * a row. PRD-007's own criterion is that an unregistered subject type falls back
 * to a generic card rather than crashing, and dropping the notification instead
 * would trade a cosmetic gap for a silently missing badge. What the enum is for
 * is the label map below and documenting the vocabulary.
 */
export const notificationSubjectTypeSchema = z.enum([
  "leave_request",
  "expense_claim",
  "quote",
  /** Reserved, unused in v1 — see SESSION-PLAN conflict C5. */
  "invoice",
  "other",
]);
export type NotificationSubjectType = z.infer<typeof notificationSubjectTypeSchema>;

/**
 * Human wording for a `subject_type`, used in the stored notification title.
 *
 * Titles are rendered at write time (see the migration comment), so this map
 * lives server-side even though the console keeps its own labels for filters and
 * dropdown grouping. That duplication is deliberate: the stored title is a
 * historical record of what the user was told, and it must not change wording
 * when the console relabels a filter.
 *
 * An unknown value is humanized rather than rejected — `expense_claim` and a
 * type this build has never heard of both come out readable.
 */
const SUBJECT_TYPE_LABELS: Record<NotificationSubjectType, string> = {
  leave_request: "leave request",
  expense_claim: "expense claim",
  quote: "quote",
  invoice: "invoice",
  other: "request",
};

export function subjectTypeLabel(subjectType: string): string {
  return (
    SUBJECT_TYPE_LABELS[subjectType as NotificationSubjectType] ?? subjectType.replace(/_/g, " ")
  );
}

export interface Notification {
  notification_id: string;
  tenant_id: string;
  user_id: string;
  /** The source event_type, unversioned (e.g. `approval.requested`). */
  type: string;
  subject_type: string;
  subject_id: string;
  title: string;
  body: string | null;
  dedupe_key: string;
  read_at: string | null;
  created_at: string;
}

/**
 * One notification the consumer wants written. Produced by the
 * event→notification map; everything here comes off the event payload, because
 * the consumer must not need a database lookup to compose a row (S3 puts both
 * `requested_by` and `approver_user_id` on every `approval.*` payload for
 * exactly this reason).
 */
export interface NotificationSpec {
  user_id: string;
  subject_type: string;
  subject_id: string;
  title: string;
  body?: string | null;
  /**
   * Natural key for the idempotent insert, unique per (user, notification) and
   * stable across redelivery of the same event. Scoped by the consumer with the
   * event type, so two different events about one subject do not collide.
   */
  dedupe_key: string;
}
