import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { Notification, NotificationPage } from "../api/types";

export const NOTIFICATIONS_KEY = ["notifications"] as const;

/** PRD-000/007: poll every 60s, but only while the tab is focused. */
export const POLL_INTERVAL_MS = 60_000;

/**
 * How many notifications the bell dropdown holds. A dropdown is a recent-activity
 * surface, not an archive — the unread *count* is always the true total (the API
 * computes it over every row), so a capped list cannot understate the badge.
 */
const BELL_PAGE_SIZE = 20;

/**
 * True while the document is visible. Kept as state rather than read inline so a
 * change re-renders the consumer and React Query re-evaluates `refetchInterval`.
 *
 * `document.visibilityState` is the signal rather than window focus: a visible
 * but unfocused tab (a second monitor) should keep polling, whereas a
 * background tab should not. jsdom defaults to "visible", so tests opt into
 * hidden explicitly.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    // Sync once on mount: the tab may already have been hidden when this
    // mounted, in which case no event is coming.
    onChange();
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export interface UseNotificationsResult {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  error: unknown;
  /** True while the tab is polling — surfaced so the UI can explain a stale badge. */
  polling: boolean;
}

/**
 * The bell's data source.
 *
 * Two refresh triggers, both from PRD-000: a 60s interval **only while the tab is
 * visible**, and a refetch on every route change. The route-change refetch is
 * what makes the badge feel live during normal use — a user clicking around the
 * console gets a fresh count on each navigation without waiting out the interval.
 *
 * Pausing in a background tab is a stated acceptance criterion, not an
 * optimisation: a console left open on a spare monitor overnight would otherwise
 * make ~1,400 pointless requests.
 */
export function useNotifications(): UseNotificationsResult {
  const { client } = useAuth();
  const visible = useDocumentVisible();
  const queryClient = useQueryClient();
  const location = useLocation();

  const query = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => client!.get<NotificationPage>(`/v1/notifications?limit=${BELL_PAGE_SIZE}`),
    enabled: !!client,
    // `false` stops the interval outright; React Query re-reads this whenever the
    // component re-renders, which the visibility listener guarantees.
    refetchInterval: visible ? POLL_INTERVAL_MS : false,
    // A hidden tab must not refetch on regaining focus *and* on visibility
    // change — one refresh on return is enough.
    refetchOnWindowFocus: false,
  });

  // Refetch on route change. Deliberately keyed on pathname only: a query-string
  // change (a filter, a tab) is not a navigation worth a notifications request.
  useEffect(() => {
    if (!client) return;
    void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  }, [location.pathname, client, queryClient]);

  return {
    notifications: query.data?.items ?? [],
    unreadCount: query.data?.unread_count ?? 0,
    isLoading: query.isLoading,
    error: query.error,
    polling: visible,
  };
}
