import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
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
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderShell() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<div>Dashboard content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("Layout (authenticated shell)", () => {
  it("renders the routed content and the department sidebar after login", async () => {
    renderShell();

    // The routed page renders (app did not blank out).
    expect(await screen.findByText("Dashboard content")).toBeDefined();

    // Sidebar paints its department lens once the session resolves: the
    // Overview link, a couple of live department groups, and the active company.
    await waitFor(() => expect(screen.getByText("Departments")).toBeDefined());
    expect(screen.getByText("Finance")).toBeDefined();
    expect(screen.getByText("Sales & Business Development")).toBeDefined();
    expect(screen.getByText("Acme Inc")).toBeDefined();
  });
});
