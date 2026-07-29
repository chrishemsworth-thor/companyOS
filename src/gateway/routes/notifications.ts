import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { paginate, pageQuerySchema } from "../pagination";
import {
  listNotifications,
  markAllRead,
  markRead,
  NotificationsError,
  unreadCount,
} from "../../modules/notifications/service";

/**
 * Notifications HTTP surface (PRD-000c).
 *
 * Read-and-acknowledge only. There is no `POST /v1/notifications`, deliberately:
 * rows are created by the event consumer and nothing else, so an endpoint that
 * conjured one would be a second writer for the table PRD-000 says has exactly
 * one (SESSION-PLAN conflict C4).
 *
 * Every route is scoped to the *calling user*, not the tenant. No `requireRole`
 * guard, for the same reason the approvals routes have none: everybody has
 * notifications, and the question is never "what role are you" but "are these
 * yours".
 */

export const notifications = new Hono<AuthedEnv>();

function notificationsErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof NotificationsError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

/**
 * The calling user, or a 400.
 *
 * A tenant API key authenticates a tenant, not a person, so it has no
 * notifications — mirroring the approvals routes' `requireUser`. Returning an
 * empty list instead would let a programmatic caller poll forever and conclude
 * nothing was happening, which is worse than a clear error.
 */
function requireUser(c: Context<AuthedEnv>, action: string): string | Response {
  const actor = c.get("user");
  const userId = actor?.type === "user" && actor.id ? actor.id : null;
  if (!userId) {
    return c.json(
      {
        error: `${action} requires an authenticated user session; a tenant API key has no user identity`,
        code: "invalid_request",
      },
      400,
    );
  }
  return userId;
}

const listQuerySchema = pageQuerySchema.extend({
  /** `?unread=true` — the bell's default view. */
  unread: z.enum(["true", "false"]).optional(),
});

/**
 * `GET /v1/notifications?unread=true`
 *
 * Newest first — the opposite of the approvals inbox, because this is a record of
 * what happened rather than a queue of work.
 *
 * `unread_count` rides along on every response so the bell's badge costs no
 * second request. It counts ALL unread rows, not the ones on this page: the badge
 * is a total, and a user with 60 unread notifications must not see "50".
 */
notifications.get("/", async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "invalid_request" }, 400);
  }
  const userId = requireUser(c, "listing notifications");
  if (typeof userId !== "string") return userId;

  const query = parsed.data;
  const tenantId = c.get("tenant").tenant_id;
  const rows = await listNotifications(c.env.DB, tenantId, userId, {
    unread_only: query.unread === "true",
    limit: query.limit,
    cursor: query.cursor,
  });

  return c.json({
    ...paginate(rows, query.limit, "notification_id"),
    unread_count: await unreadCount(c.env.DB, tenantId, userId),
  });
});

/**
 * `POST /v1/notifications/:id/read`
 *
 * Idempotent — a second call returns the row with its original `read_at`. The
 * console marks on click and a double-click is not an error.
 *
 * Another user's notification 404s rather than 403s, so the response never
 * confirms an id exists outside the caller's own feed.
 */
notifications.post("/:id/read", async (c) => {
  const userId = requireUser(c, "marking a notification read");
  if (typeof userId !== "string") return userId;

  const tenantId = c.get("tenant").tenant_id;
  try {
    const row = await markRead(c.env.DB, tenantId, userId, c.req.param("id"));
    return c.json({
      ...row,
      unread_count: await unreadCount(c.env.DB, tenantId, userId),
    });
  } catch (err) {
    return notificationsErrorResponse(c, err);
  }
});

/** `POST /v1/notifications/read-all` — clear the badge in one action. */
notifications.post("/read-all", async (c) => {
  const userId = requireUser(c, "marking notifications read");
  if (typeof userId !== "string") return userId;

  const tenantId = c.get("tenant").tenant_id;
  const marked = await markAllRead(c.env.DB, tenantId, userId);
  return c.json({ marked, unread_count: 0 });
});
