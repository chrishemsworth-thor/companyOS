import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { ToastProvider } from "./Toast";
import { NotificationBell } from "./NotificationBell";
import { POLL_INTERVAL_MS } from "../hooks/useNotifications";
import type { Notification } from "../api/types";

/**
 * The notification bell (PRD-007 § "P0 — Notification bell").
 *
 * All four acceptance criteria live here:
 *
 *  1. three unread → the badge shows 3
 *  2. clicking a notification lands on the subject and the count decreases
 *  3. a background tab stops polling
 *  4. a notification whose subject cannot be shown renders as unavailable rather
 *     than erroring
 *
 * Criterion 3 is the one that would rot silently — nothing visibly breaks when a
 * console left open on a spare monitor makes 1,400 requests overnight — so it is
 * asserted on the actual request count with fake timers.
 */

const fetchMock = vi.fn();

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    notification_id: "ntf_1",
    type: "approval.requested",
    subject_type: "quote",
    subject_id: "qte_1",
    title: "Approval needed: quote",
    body: null,
    read_at: null,
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

/** Current notifications and unread count the mock server answers with. */
let feed: Notification[] = [];
let markReadCalls: string[] = [];
let readAllCalls = 0;
/** Every /v1/notifications list request, for the polling assertions. */
let listRequests = 0;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  feed = [];
  markReadCalls = [];
  readAllCalls = 0;
  listRequests = 0;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/v1/auth/me")) {
      return jsonResponse({
        user: {
          user_id: "usr_1",
          email: "manager@acme.com",
          display_name: "Manager",
          role: "operator",
          status: "active",
        },
        tenant: { tenant_id: "biz_1", name: "Acme Inc", onboarded_at: "2026-01-01T00:00:00Z" },
        csrf_token: "csrf_1",
      });
    }
    if (path.includes("/v1/notifications/read-all")) {
      readAllCalls += 1;
      feed = feed.map((n) => ({ ...n, read_at: new Date().toISOString() }));
      return jsonResponse({ marked: 1, unread_count: 0 });
    }
    if (path.match(/\/v1\/notifications\/[^/]+\/read$/)) {
      const id = path.split("/").slice(-2)[0]!;
      markReadCalls.push(id);
      feed = feed.map((n) =>
        n.notification_id === id ? { ...n, read_at: new Date().toISOString() } : n,
      );
      return jsonResponse({ ...feed.find((n) => n.notification_id === id) });
    }
    if (path.includes("/v1/notifications")) {
      listRequests += 1;
      return jsonResponse({
        items: feed,
        next_cursor: null,
        unread_count: feed.filter((n) => !n.read_at).length,
      });
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? "GET"}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // jsdom keeps document state between tests in a file.
  setVisibility("visible");
});

/** Drive `document.visibilityState`, which jsdom does not let you assign directly. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** The bell inside the providers it needs, plus a route to navigate to. */
function renderBell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={["/"]}>
            <NotificationBell />
            <Routes>
              <Route path="/" element={<div>Dashboard page</div>} />
              <Route path="/quotes/:id" element={<div>Quote detail page</div>} />
              <Route path="/approvals" element={<div>Approvals inbox page</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("the badge", () => {
  it("shows 3 for three unread notifications", async () => {
    feed = [
      notification({ notification_id: "ntf_1" }),
      notification({ notification_id: "ntf_2" }),
      notification({ notification_id: "ntf_3" }),
    ];
    renderBell();

    const badge = await screen.findByTestId("notification-badge");
    expect(badge.textContent).toBe("3");
  });

  it("shows no badge at all when everything is read", async () => {
    feed = [notification({ read_at: new Date().toISOString() })];
    renderBell();

    // Wait for the feed to have loaded before asserting an absence, or the test
    // would pass on the loading state.
    await screen.findByRole("button", { name: "Notifications" });
    expect(screen.queryByTestId("notification-badge")).toBeNull();
  });

  it("caps the badge rather than blowing out the header", async () => {
    feed = Array.from({ length: 120 }, (_, i) => notification({ notification_id: `ntf_${i}` }));
    renderBell();

    expect((await screen.findByTestId("notification-badge")).textContent).toBe("99+");
  });

  it("puts the unread count in the accessible name", async () => {
    feed = [notification()];
    renderBell();

    expect(await screen.findByRole("button", { name: "Notifications (1 unread)" })).toBeTruthy();
  });
});

describe("clicking a notification", () => {
  it("navigates to the subject and decreases the count", async () => {
    feed = [notification({ notification_id: "ntf_1", subject_type: "quote", subject_id: "qte_7" })];
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    fireEvent.click(await screen.findByText("Approval needed: quote"));

    // Landed on the subject...
    await screen.findByText("Quote detail page");
    // ...and marked read, so the badge is gone on the next poll.
    expect(markReadCalls).toEqual(["ntf_1"]);
    await waitFor(() => expect(screen.queryByTestId("notification-badge")).toBeNull());
  });

  it("does not re-mark an already-read notification", async () => {
    feed = [notification({ read_at: new Date().toISOString() })];
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    fireEvent.click(await screen.findByText("Approval needed: quote"));

    expect(markReadCalls).toEqual([]);
  });

  it("marks everything read from one action", async () => {
    feed = [notification({ notification_id: "ntf_1" }), notification({ notification_id: "ntf_2" })];
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    fireEvent.click(await screen.findByRole("button", { name: /mark all read/i }));

    await waitFor(() => expect(readAllCalls).toBe(1));
    await waitFor(() => expect(screen.queryByTestId("notification-badge")).toBeNull());
  });
});

describe("a subject this build cannot show", () => {
  it("renders as unavailable and falls back to the inbox instead of erroring", async () => {
    // PRD-007: "given a notification whose subject was deleted or cancelled, then
    // the item renders as unavailable rather than erroring." Same code path as a
    // subject_type whose screen has not shipped. The stand-in keeps moving as
    // sessions ship screens — `expense_claim` until S5, `leave_request` until
    // S7 — so this uses `other`, the generic approval, which has a label but is
    // never routable by design.
    feed = [
      notification({
        subject_type: "other",
        subject_id: "oth_gone",
        title: "Approval needed: leave request",
      }),
    ];
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));

    expect(await screen.findByText("Approval needed: leave request")).toBeTruthy();
    expect(screen.getByText(/opens in the approvals inbox/i)).toBeTruthy();

    fireEvent.click(screen.getByText("Approval needed: leave request"));
    await screen.findByText("Approvals inbox page");
  });
});

describe("grouping and content", () => {
  it("groups notifications by type under readable headings", async () => {
    feed = [
      notification({ notification_id: "ntf_1", type: "approval.requested" }),
      notification({ notification_id: "ntf_2", type: "approval.rejected", title: "Rejected: your quote" }),
    ];
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));

    expect(await screen.findByText("Awaiting your decision")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
  });

  it("shows the decision comment as the body", async () => {
    feed = [
      notification({
        type: "approval.rejected",
        title: "Rejected: your expense claim",
        body: "Receipt is illegible",
        subject_type: "expense_claim",
      }),
    ];
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));

    expect(await screen.findByText("Receipt is illegible")).toBeTruthy();
  });

  it("says something useful when the feed is empty", async () => {
    renderBell();

    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));

    // Not "no notifications" — say what the absence means.
    expect(await screen.findByText(/you are all caught up/i)).toBeTruthy();
    expect(screen.getByText(/approval requests and decisions/i)).toBeTruthy();
  });
});

describe("polling", () => {
  /**
   * Fake timers must be installed BEFORE render, not after: React Query schedules
   * its refetch interval when the query mounts, and a timer created against the
   * real clock is invisible to a fake one installed later. `shouldAdvanceTime`
   * keeps the clock ticking in real time so `waitFor` and fetch promises still
   * resolve normally.
   */
  function useAdvanceableTimers() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  }

  it("polls every 60s while the tab is visible", async () => {
    useAdvanceableTimers();
    feed = [notification()];
    renderBell();
    await waitFor(() => expect(listRequests).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1_000);
    });

    expect(listRequests).toBeGreaterThan(1);
  });

  it("pauses polling in a background tab", async () => {
    // The criterion. A console left open overnight on a hidden tab would
    // otherwise make ~1,400 requests nobody reads.
    useAdvanceableTimers();
    feed = [notification()];
    renderBell();
    await waitFor(() => expect(listRequests).toBe(1));

    setVisibility("hidden");
    // Let the visibility listener's state update flush so React Query re-reads
    // refetchInterval before the clock is advanced.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });

    expect(listRequests).toBe(1);
  });

  it("resumes when the tab comes back", async () => {
    useAdvanceableTimers();
    feed = [notification()];
    renderBell();
    await waitFor(() => expect(listRequests).toBe(1));

    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });
    expect(listRequests).toBe(1);

    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1_000);
    });

    expect(listRequests).toBeGreaterThan(1);
  });
});
