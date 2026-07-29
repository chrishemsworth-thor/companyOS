import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Check, Inbox } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNotifications, NOTIFICATIONS_KEY } from "../hooks/useNotifications";
import { notificationTypeLabel, subjectRoute } from "../lib/subjectRoutes";
import { cn } from "../lib/cn";
import type { Notification } from "../api/types";

/**
 * The header notification bell (PRD-007 § "P0 — Notification bell").
 *
 * Mounted once, in TopBar, so it is present on every console page. Everything it
 * knows comes from `useNotifications` — including whether polling is live.
 *
 * Mobile matters here: PRD-007 gives `/approvals` and this bell the console's only
 * hard 375px requirement. Under `sm` the panel is a full-width sheet pinned below
 * the header rather than a narrow dropdown that would overflow the viewport.
 */

/** Cap the badge so a neglected console shows "99+" rather than blowing out the header. */
const BADGE_CAP = 99;

/** Relative age, for a feed where "3h ago" beats a timestamp. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Group by notification type, preserving the newest-first order within a group. */
function groupByType(notifications: Notification[]): [string, Notification[]][] {
  const groups = new Map<string, Notification[]>();
  for (const n of notifications) {
    const existing = groups.get(n.type);
    if (existing) existing.push(n);
    else groups.set(n.type, [n]);
  }
  return [...groups.entries()];
}

export function NotificationBell() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { notifications, unreadCount, isLoading, polling } = useNotifications();

  // Close on outside click and on Escape — a header popover that traps the user
  // is worse than no popover.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markRead = useMutation({
    mutationFn: (id: string) => client!.post(`/v1/notifications/${id}/read`),
    // Invalidate rather than optimistically writing: the response carries the
    // authoritative unread_count, and the badge is the one number that must not
    // drift.
    onSettled: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  const markAllRead = useMutation({
    mutationFn: () => client!.post("/v1/notifications/read-all"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  /**
   * Click-through: mark read, then navigate to the subject.
   *
   * Marking read is fire-and-forget on purpose — a failed mark-read must not
   * strand the user on the bell. The invalidation in `onSettled` reconciles the
   * badge either way, and the notification simply stays unread if the call fails.
   *
   * A subject this build cannot route to (`subjectRoute` → null) still gets
   * marked read but does not navigate: PRD-007's criterion is that such an item
   * "renders as unavailable rather than erroring".
   */
  function handleClick(notification: Notification) {
    if (!notification.read_at) markRead.mutate(notification.notification_id);
    const route = subjectRoute(notification.subject_type, notification.subject_id);
    setOpen(false);
    if (route) navigate(route);
    else navigate("/approvals");
  }

  const groups = groupByType(notifications);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"
        }
        aria-expanded={open}
        // 40px square: a comfortable touch target at 375px, matching Button's
        // `icon` size.
        className="relative grid size-10 cursor-pointer place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {polling ? <Bell className="size-5" /> : <BellOff className="size-5" />}
        {unreadCount > 0 && (
          <span
            // The badge is the count, exposed as text so it is readable by
            // assistive tech and assertable in a test.
            data-testid="notification-badge"
            className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-bad px-1 text-[0.6rem] font-bold leading-4 text-white"
          >
            {unreadCount > BADGE_CAP ? `${BADGE_CAP}+` : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className={cn(
            "absolute z-50 overflow-hidden rounded-lg border border-border bg-surface shadow-lg",
            // Mobile: a full-width sheet pinned under the header. Desktop: a
            // conventional right-aligned dropdown.
            "-right-2 top-12 max-h-[70vh] w-[calc(100vw-1rem)] max-w-[22rem] sm:right-0 sm:w-96",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-semibold text-fg">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
                className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-xs font-semibold text-accent hover:bg-accent-soft disabled:opacity-55"
              >
                <Check className="size-3.5" aria-hidden />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[calc(70vh-2.5rem)] overflow-y-auto">
            {isLoading && (
              <div className="px-3 py-6 text-center text-sm text-subtle">Loading…</div>
            )}

            {!isLoading && notifications.length === 0 && (
              // "Useful, not 'no notifications'" — say what the absence means and
              // where the work actually lives.
              <div className="flex flex-col items-center gap-1.5 px-6 py-8 text-center">
                <Inbox className="size-6 text-subtle" aria-hidden />
                <div className="text-sm font-medium text-fg">You are all caught up</div>
                <div className="text-xs text-subtle">
                  Approval requests and decisions on your requests show up here.
                </div>
              </div>
            )}

            {groups.map(([type, items]) => (
              <div key={type}>
                <div className="sticky top-0 bg-surface-2 px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-wider text-subtle">
                  {notificationTypeLabel(type)}
                </div>
                {items.map((n) => {
                  const routable = subjectRoute(n.subject_type, n.subject_id) !== null;
                  return (
                    <button
                      key={n.notification_id}
                      type="button"
                      onClick={() => handleClick(n)}
                      className={cn(
                        "flex w-full cursor-pointer flex-col items-start gap-0.5 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-surface-2",
                        !n.read_at && "bg-accent-soft/40",
                      )}
                    >
                      <span className="flex w-full items-start gap-2">
                        {!n.read_at && (
                          <span
                            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent"
                            aria-label="Unread"
                          />
                        )}
                        <span className="min-w-0 flex-1 text-sm font-medium text-fg">
                          {n.title}
                        </span>
                        <span className="shrink-0 text-xs text-subtle">
                          {relativeTime(n.created_at)}
                        </span>
                      </span>
                      {n.body && (
                        <span className="line-clamp-2 pl-3.5 text-xs text-muted">{n.body}</span>
                      )}
                      {!routable && (
                        // The subject has no screen in this build — either it was
                        // removed, or its module has not shipped yet. Say so
                        // rather than sending the user somewhere broken.
                        <span className="pl-3.5 text-xs italic text-subtle">
                          Opens in the approvals inbox
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
