import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../auth/AuthContext";
import { CustomerDetail } from "./CustomerDetail";
import { CustomerList } from "./CustomerList";
import type { CustomerHealth } from "../../api/types";

/**
 * PRD-003 console requirements: "health badge on the customer list and a
 * reasons panel on the detail page".
 *
 * The reasons panel is the one that matters — PRD-003 says the reasons are more
 * actionable than the band, so these assert on the reason text, not just the
 * badge.
 */

const fetchMock = vi.fn();

const AT_RISK: CustomerHealth = {
  band: "at_risk",
  reasons: [
    {
      code: "invoices_severely_overdue",
      detail: "2 invoices overdue, the oldest by 75 days (inv_a, inv_b).",
      band: "at_risk",
      invoice_ids: ["inv_a", "inv_b"],
    },
    {
      code: "open_tickets",
      detail: "1 open ticket, the oldest 3 days old.",
      band: "watch",
    },
  ],
};

const BASE_CUSTOMER = {
  customer_id: "cust_1",
  name: "Slow Payer Sdn Bhd",
  email: null,
  phone: null,
  legal_name: null,
  reg_no: null,
  tax_no: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  postcode: null,
  country: null,
  industry: null,
  website: null,
  payment_terms_days: 45,
  credit_limit_cents: 500_000,
  preferred_channel: null,
  notes: null,
  ship_address_line1: null,
  ship_address_line2: null,
  ship_city: null,
  ship_state: null,
  ship_postcode: null,
  ship_country: null,
};

function stubFetch(detail: Record<string, unknown>, list?: Record<string, unknown>[]) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/contacts")) return new Response(JSON.stringify({ contacts: [] }), { status: 200 });
    if (u.includes("/payment-history")) return new Response(JSON.stringify({ payments: [] }), { status: 200 });
    if (u.includes("/activities")) return new Response(JSON.stringify({ activities: [] }), { status: 200 });
    if (u.includes("/agent")) return new Response(JSON.stringify({ agent_state: null }), { status: 200 });
    if (u.includes("/v1/events")) return new Response(JSON.stringify({ events: [] }), { status: 200 });
    if (u.match(/\/v1\/customers\/[^/?]+$/)) return new Response(JSON.stringify(detail), { status: 200 });
    if (u.includes("/v1/customers"))
      return new Response(JSON.stringify({ customers: list ?? [], next_cursor: null }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

beforeEach(() => {
  sessionStorage.setItem("companyos_api_key", "key_test");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/customers/cust_1"]}>
          <Routes>
            <Route path="/customers/:id" element={<CustomerDetail />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function renderList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <CustomerList />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("the reasons panel on customer detail", () => {
  it("shows the band and every contributing reason", async () => {
    stubFetch({
      ...BASE_CUSTOMER,
      health: AT_RISK,
      credit: { limit_cents: 500_000, outstanding_ar_cents: 800_000, available_cents: -300_000 },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText("Account health")).toBeDefined());
    expect(screen.getByText("At risk")).toBeDefined();
    expect(
      screen.getByText("2 invoices overdue, the oldest by 75 days (inv_a, inv_b)."),
    ).toBeDefined();
    expect(screen.getByText("1 open ticket, the oldest 3 days old.")).toBeDefined();
  });

  it("links the invoices a reason names", async () => {
    stubFetch({ ...BASE_CUSTOMER, health: AT_RISK });
    renderDetail();

    await waitFor(() => expect(screen.getByText("inv_a")).toBeDefined());
    expect(screen.getByText("inv_a").getAttribute("href")).toBe("/invoices/inv_a");
    expect(screen.getByText("inv_b").getAttribute("href")).toBe("/invoices/inv_b");
  });

  it("says a customer is over its credit limit without stopping anything", async () => {
    stubFetch({
      ...BASE_CUSTOMER,
      health: AT_RISK,
      credit: { limit_cents: 500_000, outstanding_ar_cents: 800_000, available_cents: -300_000 },
    });
    renderDetail();

    await waitFor(() => expect(screen.getAllByText(/over limit/).length).toBeGreaterThan(0));
    // Warn only: the panel reports the breach and nothing on the page says the
    // customer is blocked, suspended, or on hold.
    expect(screen.queryByText(/blocked|suspended|on hold/i)).toBeNull();
  });

  it("shows the resolved payment terms", async () => {
    stubFetch({ ...BASE_CUSTOMER, health: AT_RISK });
    renderDetail();
    await waitFor(() => expect(screen.getByText("45 days")).toBeDefined());
  });

  it("says 'tenant default' rather than a made-up number when terms are unset", async () => {
    stubFetch({ ...BASE_CUSTOMER, payment_terms_days: null, health: AT_RISK });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Tenant default")).toBeDefined());
  });
});

describe("the health badge on the customer list", () => {
  it("badges each row from the list payload", async () => {
    stubFetch(BASE_CUSTOMER, [
      { ...BASE_CUSTOMER, customer_id: "cust_1", name: "Risky", health_band: "at_risk" },
      { ...BASE_CUSTOMER, customer_id: "cust_2", name: "Watchful", health_band: "watch" },
      { ...BASE_CUSTOMER, customer_id: "cust_3", name: "Fine", health_band: "good" },
    ]);
    renderList();

    // DataTable renders a table and a stacked mobile view, so each label
    // legitimately appears more than once.
    await waitFor(() => expect(screen.getAllByText("Risky").length).toBeGreaterThan(0));
    expect(screen.getAllByText("At risk").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Watch").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Good").length).toBeGreaterThan(0);
  });

  it("renders a dash rather than a badge when the band is missing", async () => {
    stubFetch(BASE_CUSTOMER, [
      { ...BASE_CUSTOMER, customer_id: "cust_1", name: "Unknown", health_band: null },
    ]);
    renderList();

    await waitFor(() => expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0));
    expect(screen.queryByText("At risk")).toBeNull();
    expect(screen.queryByText("Good")).toBeNull();
  });
});
