import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../auth/AuthContext";
import { Layout } from "./Layout";

// Regression guard for the "blank page right after login" crash: SidebarContent
// once referenced identifiers that no longer existed (NAV_GROUPS/live/planned),
// throwing a ReferenceError at render and unmounting the whole app. Mounting the
// authenticated shell and asserting it paints catches that class of bug — a
// render throw here fails the test instead of silently blanking the browser.

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // AuthProvider bootstraps by calling /v1/auth/me on mount; answer as an
  // authenticated admin so the full department lens renders.
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("/v1/auth/me")) {
      return new Response(
        JSON.stringify({
          user: {
            user_id: "usr_1",
            email: "admin@acme.com",
            display_name: "Admin",
            role: "admin",
            status: "active",
          },
          tenant: { tenant_id: "biz_1", name: "Acme Inc" },
          csrf_token: "csrf_1",
        }),
        { status: 200 },
      );
    }
    // The shell's notification bell polls this. Answer it rather than throwing:
    // an unhandled rejection here would surface as an unrelated shell failure.
    if (String(url).includes("/v1/notifications")) {
      return new Response(JSON.stringify({ items: [], next_cursor: null, unread_count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderShell() {
  // The shell mounts the notification bell (TopBar → NotificationBell), which is
  // a React Query consumer, so the provider is part of the shell's contract now.
  // App.tsx has always supplied one; this test has to as well.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<div>Dashboard content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Layout (authenticated shell)", () => {
  it("renders the routed content and the department sidebar after login", async () => {
    renderShell();

    // The routed page renders (app did not blank out).
    expect(await screen.findByText("Dashboard content")).toBeDefined();

    // Sidebar paints its department lens once the session resolves: the
    // Overview link, a couple of live department groups, and the active company.
    // Scoped to the complementary landmark: the mobile drawer renders the
    // same content a second time (always mounted so it can be
    // swipe-gestured), but stays aria-hidden while closed, so the role query
    // still resolves to the one visible <aside>.
    await waitFor(() => expect(screen.getByRole("complementary")).toBeDefined());
    const sidebar = within(screen.getByRole("complementary"));
    expect(sidebar.getByText("Departments")).toBeDefined();
    expect(sidebar.getByText("Finance")).toBeDefined();
    expect(sidebar.getByText("Sales & Business Development")).toBeDefined();
    expect(sidebar.getByText("Acme Inc")).toBeDefined();
  });

  it("keeps Approvals in the sidebar, outside the department lens", async () => {
    // This link was silently dropped once already, resolving a merge between
    // PRD-007 (which added it) and PRD-008 (which restructured the nav). Nothing
    // caught it: the route still existed, the page still worked, and the only
    // symptom was that no one could reach it from the sidebar. Hence a test.
    renderShell();

    const link = await waitFor(() => screen.getByRole("link", { name: "Approvals" }));
    expect(link.getAttribute("href")).toBe("/approvals");
  });

  it("puts Approvals under 'You', not under the department Overview", async () => {
    // Deliberate placement, not cosmetic: "Overview" is hidden from the
    // self-service tier (it sees no departments), and that tier is exactly who
    // needs this screen — it is where an employee tracks the leave request or
    // claim they filed. Under "You" it is visible to every role.
    renderShell();

    await waitFor(() => expect(screen.getByRole("link", { name: "Approvals" })).toBeDefined());
    const section = screen.getByRole("link", { name: "Approvals" }).closest("div")?.parentElement;
    expect(section?.textContent).toContain("You");
  });

  it("opens the mobile drawer from the hamburger and closes it from its own close button", async () => {
    // The drawer is now always mounted (rather than only while open) so it can
    // be edge-swiped/dragged, not just tapped — this guards the plain tap-open/
    // tap-close path still works after that rewrite. The gesture-drag path
    // itself isn't covered here: jsdom has no real pointer/touch physics, so
    // that needs a manual or real-device check instead.
    renderShell();
    await waitFor(() => expect(screen.getByRole("complementary")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "Approvals" })).toHaveLength(2),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "Approvals" })).toHaveLength(1),
    );
  });
});
