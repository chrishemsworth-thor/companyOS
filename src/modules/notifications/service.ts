import { ulid } from "../../lib/ulid";
import type { Notification, NotificationSpec } from "./types";

/**
 * Notifications primitive (PRD-000c) — read/write service.
 *
 * The write side has exactly one caller: the event consumer
 * (src/modules/notifications/consumer.ts). PRD-000 requires rows be created by
 * a consumer rather than by module code, so `createNotifications` is not
 * exported for general use by intent — a module that wants to notify somebody
 * emits an event and extends the consumer's map (SESSION-PLAN conflict C4).
 *
 * The read side backs the console bell: a list, an unread count, and two
 * mark-read paths.
 */

export class NotificationsError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_request",
    message: string,
    readonly httpStatus: 400 | 404,
  ) {
    super(message);
    this.name = "NotificationsError";
  }
}

const NOTIFICATION_COLUMNS =
  "notification_id, tenant_id, user_id, type, subject_type, subject_id, title, body, " +
  "dedupe_key, read_at, created_at";

/**
 * Write the rows one event produced, idempotently.
 *
 * `INSERT OR IGNORE` against the unique `(tenant_id, user_id, dedupe_key)`
 * index is the whole idempotency story: a redelivered event (paid plan, queue
 * retry) or a replayed one writes nothing the second time. Returns the number of
 * rows actually inserted so the consumer can log a redelivery without guessing.
 *
 * Does not throw on a duplicate. Callers on the inline free-plan path have no
 * retry available, so the only useful failure mode is "no row and a log line" —
 * see the consumer.
 */
export async function createNotifications(
  db: D1Database,
  tenantId: string,
  type: string,
  specs: readonly NotificationSpec[],
): Promise<number> {
  if (specs.length === 0) return 0;

  const statements = specs.map((spec) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO notifications
           (notification_id, tenant_id, user_id, type, subject_type, subject_id, title, body, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `ntf_${ulid()}`,
        tenantId,
        spec.user_id,
        type,
        spec.subject_type,
        spec.subject_id,
        spec.title,
        spec.body ?? null,
        spec.dedupe_key,
      ),
  );

  const results = await db.batch(statements);
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

export interface ListNotificationsFilter {
  /** Only rows the user has not read yet. */
  unread_only?: boolean;
  limit: number;
  cursor?: string;
}

/**
 * A user's notifications, NEWEST first.
 *
 * The opposite order to `listApprovals`, and deliberately: an approvals queue is
 * work to get through, so the oldest item is the most urgent, whereas a
 * notification feed is a record of what just happened. `notification_id` is a
 * ULID, so `ORDER BY notification_id DESC` is reverse-chronological and the
 * cursor helper works unchanged on `notification_id < cursor`.
 *
 * Fetches `limit + 1` rows so the caller can detect another page without a
 * COUNT.
 */
export async function listNotifications(
  db: D1Database,
  tenantId: string,
  userId: string,
  filter: ListNotificationsFilter,
): Promise<Notification[]> {
  const where = ["tenant_id = ?", "user_id = ?"];
  const binds: unknown[] = [tenantId, userId];
  if (filter.unread_only) {
    where.push("read_at IS NULL");
  }
  if (filter.cursor) {
    where.push("notification_id < ?");
    binds.push(filter.cursor);
  }
  binds.push(filter.limit + 1);

  const { results } = await db
    .prepare(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
       WHERE ${where.join(" AND ")}
       ORDER BY notification_id DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<Notification>();
  return results ?? [];
}

/**
 * The badge number. Returned alongside every list response so the bell needs
 * one request per poll rather than two — this runs on every console page load
 * and every 60s while the tab is focused.
 */
export async function unreadCount(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications
       WHERE tenant_id = ? AND user_id = ? AND read_at IS NULL`,
    )
    .bind(tenantId, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Mark one notification read.
 *
 * Idempotent: marking an already-read row returns it with its original
 * `read_at` rather than 409-ing or re-stamping it. The console marks on click
 * and a double-click is not an error, and the first-seen timestamp is the
 * interesting one.
 *
 * Scoped by `(tenant_id, user_id)`, so another user's — or another tenant's —
 * notification id simply does not resolve and the route turns that into a 404.
 * Not a 403: a 403 would confirm the id exists.
 */
export async function markRead(
  db: D1Database,
  tenantId: string,
  userId: string,
  notificationId: string,
): Promise<Notification> {
  await db
    .prepare(
      `UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE tenant_id = ? AND user_id = ? AND notification_id = ? AND read_at IS NULL`,
    )
    .bind(tenantId, userId, notificationId)
    .run();

  const row = await db
    .prepare(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
       WHERE tenant_id = ? AND user_id = ? AND notification_id = ?`,
    )
    .bind(tenantId, userId, notificationId)
    .first<Notification>();
  if (!row) throw new NotificationsError("not_found", "notification not found", 404);
  return row;
}

/** Mark everything unread as read. Returns how many rows changed. */
export async function markAllRead(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE tenant_id = ? AND user_id = ? AND read_at IS NULL`,
    )
    .bind(tenantId, userId)
    .run();
  return result.meta?.changes ?? 0;
}
