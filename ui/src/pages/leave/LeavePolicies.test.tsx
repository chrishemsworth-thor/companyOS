import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../auth/AuthContext";
import { ToastProvider } from "../../components/Toast";
import { LeavePolicies } from "./LeavePolicies";
import type { AdminLeaveType, LeavePolicy } from "../../api/types";

/**
 * Leave policy configuration (PRD-006b).
 *
 * The engine behind this screen has been tested since S6; what is untested
 * until here is that an HR administrator can reach any of it. So these assert
 * the two things a form in front of a correct engine can still get wrong:
 * that what the server already holds is shown accurately, and that what the
 * form sends back is the shape the server accepts.
 *
 * The carry-forward cases carry the most weight. `carry_forward_max_days` and
 * `carry_forward_expiry_months` are independent — days without an expiry is a
 * valid policy, an expiry without days is meaningless — and the second is
 * expressed in the UI as a checkbox plus a select rather than as a nullable
 * number, so the mapping back to `null` is this file's job to pin.
 */

const fetchMock = vi.fn();
let types: AdminLeaveType[] = [];
let policies: LeavePolicy[] = [];
const posts: { path: string; method: string; body: Record<string, unknown> }[] = [];

function leaveType(overrides: Partial<AdminLeaveType> = {}): AdminLeaveType {
  return {
    leave_type_id: "lvt_annual",
    code: "annual",
    name: "Annual Leave",
    description: null,
    is_paid: true,
    requires_attachment: false,
    max_consecutive_days: null,
    allows_half_day: true,
    carry_forward_allowed: true,
    allow_negative_balance: false,
    statutory_basis: "annual",
    archived_at: null,
    ...overrides,
  };
}

function policy(overrides: Partial<LeavePolicy> = {}): LeavePolicy {
  return {
    policy_id: "lvp_1",
    leave_type_id: "lvt_annual",
    name: "Standard annual",
    accrual_method: "monthly_accrual",
    carry_forward_max_days: 5,
    carry_forward_expiry_months: 3,
    is_default: true,
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    bands: [
      {
        band_id: "lvb_1",
        employment_type: null,
        min_months_service: 0,
        max_months_service: 24,
        entitlement_days: 12,
      },
      {
        band_id: "lvb_2",
        employment_type: null,
        min_months_service: 24,
        max_months_service: null,
        entitlement_days: 16,
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  types = [leaveType()];
  policies = [policy()];
  posts.length = 0;

  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (path.includes("/v1/auth/me")) {
      return jsonResponse({
        user: {
          user_id: "usr_hr",
          email: "hr@acme.com",
          display_name: "HR",
          role: "admin",
          status: "active",
        },
        tenant: { tenant_id: "biz_1", name: "Acme Inc", onboarded_at: "2026-01-01T00:00:00Z" },
        csrf_token: "csrf_1",
      });
    }
    if (method !== "GET") {
      posts.push({ path, method, body: JSON.parse(String(init?.body ?? "{}")) });
      return jsonResponse({ policy: policy() }, path.includes("/policies/") ? 200 : 201);
    }
    if (path.includes("/v1/people/leave/statutory-minimums")) {
      return jsonResponse({
        statutory_minimums: [
          {
            basis: "annual",
            bands: [
              { min_months: 0, max_months: 24, days: 8 },
              { min_months: 24, max_months: 60, days: 12 },
              { min_months: 60, max_months: null, days: 16 },
            ],
          },
        ],
      });
    }
    if (path.includes("/v1/people/leave/types")) return jsonResponse({ leave_types: types });
    if (path.includes("/v1/people/leave/policies")) return jsonResponse({ policies });
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={["/leave/policies"]}>
            <LeavePolicies />
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("what the screen shows", () => {
  it("summarises entitlement, accrual and carry-forward without opening the form", async () => {
    renderPage();

    expect(await screen.findByText("Annual Leave")).toBeTruthy();
    expect(screen.getByText("Standard annual")).toBeTruthy();
    // Bands read as policy, not as a row of month counts.
    expect(screen.getByText(/12 days for 0 years–2 years/)).toBeTruthy();
    expect(screen.getByText(/16 days after 2 years/)).toBeTruthy();
    // The carry-forward rule in one line — both halves of it.
    expect(screen.getByText(/Accrued monthly · Carries 5 days, expires after 3 months/)).toBeTruthy();
  });

  it("says a carry-forward with no expiry never lapses, rather than omitting it", async () => {
    policies = [policy({ carry_forward_expiry_months: null })];
    renderPage();
    expect(await screen.findByText(/Carries 5 days, no expiry/)).toBeTruthy();
  });

  it("says so plainly when nothing carries", async () => {
    policies = [policy({ carry_forward_max_days: 0, carry_forward_expiry_months: null })];
    renderPage();
    expect(await screen.findByText(/No carry-forward/)).toBeTruthy();
  });

  it("flags a leave type with no policy, which is what leaves employees unconfigured", async () => {
    policies = [];
    renderPage();
    expect(await screen.findByText(/No policy/)).toBeTruthy();
    expect(screen.getByText(/reads as unconfigured/)).toBeTruthy();
  });

  it("flags policies that exist but none of which is the default", async () => {
    // The subtler version of the same failure: the type looks configured, but
    // nobody falls to it without an explicit assignment.
    policies = [policy({ is_default: false })];
    renderPage();
    expect(await screen.findByText(/None of these is the default/)).toBeTruthy();
  });
});

describe("editing carry-forward", () => {
  it("loads the stored rule into the form", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /edit/i }));

    const days = screen.getByLabelText(/Days that may carry into next year/) as HTMLInputElement;
    expect(days.value).toBe("5");
    const expires = screen.getByLabelText(/Carried days expire if unused/) as HTMLInputElement;
    expect(expires.checked).toBe(true);
    const months = screen.getByLabelText(/Months into the new year/) as HTMLSelectElement;
    expect(months.value).toBe("3");
  });

  it("sends null for the expiry when the days carry indefinitely", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.click(screen.getByLabelText(/Carried days expire if unused/));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.method).toBe("PATCH");
    expect(posts[0]!.body).toMatchObject({
      carry_forward_max_days: 5,
      carry_forward_expiry_months: null,
    });
  });

  it("hides the expiry entirely when no days carry, and sends null for it", async () => {
    // An expiry on zero carried days is not a policy anybody can mean, so the
    // control is not offered — and the value sent must still be null rather
    // than a stale 3 left over from before the days were zeroed.
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /edit/i }));

    fireEvent.change(screen.getByLabelText(/Days that may carry into next year/), {
      target: { value: "0" },
    });
    expect(screen.queryByLabelText(/Carried days expire if unused/)).toBeNull();
    expect(screen.getByText(/Zero means nothing carries/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({
      carry_forward_max_days: 0,
      carry_forward_expiry_months: null,
    });
  });
});

describe("creating a policy", () => {
  it("posts bands, accrual and carry-forward in the shape the API takes", async () => {
    policies = [];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /add policy/i }));

    fireEvent.change(screen.getByLabelText(/Accrual/), {
      target: { value: "monthly_accrual" },
    });
    fireEvent.change(screen.getByLabelText(/Days \/ year/), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText(/Days that may carry into next year/), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByLabelText(/Carried days expire if unused/));
    fireEvent.change(screen.getByLabelText(/Months into the new year/), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create policy/i }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.method).toBe("POST");
    expect(posts[0]!.body).toMatchObject({
      leave_type_id: "lvt_annual",
      accrual_method: "monthly_accrual",
      carry_forward_max_days: 5,
      carry_forward_expiry_months: 3,
      is_default: true,
      bands: [
        {
          employment_type: null,
          min_months_service: 0,
          max_months_service: null,
          entitlement_days: 24,
        },
      ],
    });
  });

  it("shows the statutory floor beside the entitlement rather than enforcing it", async () => {
    // PRD-006b is explicit that below-minimum entitlements save and warn. The
    // console's job is to make the floor visible at the point of decision.
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /add policy/i }));
    expect(screen.getByText(/Employment Act 1955 minimum/)).toBeTruthy();
    expect(screen.getByText(/8 days for 0–2 years/)).toBeTruthy();
    expect(screen.getByText(/Saving below it is allowed/)).toBeTruthy();
  });

  it("explains what each accrual method means as it is chosen", async () => {
    // The choice with the largest effect on an employee's balance, and the one
    // whose names give the least away. Monthly accrual in particular is what
    // most Malaysian employers actually run.
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /add policy/i }));

    expect(screen.getByText(/full entitlement is available on 1 January/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Accrual/), {
      target: { value: "monthly_accrual" },
    });
    expect(screen.getByText(/2 days per completed month/)).toBeTruthy();
  });

  it("blocks a band whose tenure window runs backwards, before the server has to", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /add policy/i }));
    fireEvent.change(screen.getByLabelText(/Days \/ year/), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText(/From \(months\)/), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText(/Up to/), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /create policy/i }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it("adds and removes tenure bands, keeping at least one", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /add policy/i }));

    // One band to start, and it cannot be removed.
    expect((screen.getByRole("button", { name: /remove band 1/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: /add band/i }));
    expect(screen.getAllByLabelText(/Days \/ year/)).toHaveLength(2);
    expect((screen.getByRole("button", { name: /remove band 1/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByRole("button", { name: /remove band 2/i }));
    expect(screen.getAllByLabelText(/Days \/ year/)).toHaveLength(1);
  });
});

describe("who may change policy", () => {
  it("offers no write actions to a role without people:write", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path.includes("/v1/auth/me")) {
        return jsonResponse({
          user: {
            user_id: "usr_ro",
            email: "ro@acme.com",
            display_name: "Observer",
            role: "readonly",
            status: "active",
          },
          tenant: { tenant_id: "biz_1", name: "Acme Inc", onboarded_at: "2026-01-01T00:00:00Z" },
          csrf_token: "csrf_1",
        });
      }
      if (path.includes("/statutory-minimums")) return jsonResponse({ statutory_minimums: [] });
      if (path.includes("/types")) return jsonResponse({ leave_types: types });
      if (path.includes("/policies")) return jsonResponse({ policies });
      return jsonResponse({});
    });
    renderPage();

    // The policy is still readable — this is presentation, not a security
    // boundary, and hiding the data would be the wrong call for an observer.
    expect(await screen.findByText("Standard annual")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add policy/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });
});

describe("more than one leave type", () => {
  it("groups each type's policies under it", async () => {
    types = [leaveType(), leaveType({ leave_type_id: "lvt_sick", code: "sick", name: "Sick Leave", statutory_basis: "sick" })];
    policies = [
      policy(),
      policy({
        policy_id: "lvp_2",
        leave_type_id: "lvt_sick",
        name: "Standard sick",
        carry_forward_max_days: 0,
        carry_forward_expiry_months: null,
      }),
    ];
    renderPage();

    const annual = (await screen.findByText("Annual Leave")).closest("section")!;
    const sick = screen.getByText("Sick Leave").closest("section")!;
    expect(within(annual).getByText("Standard annual")).toBeTruthy();
    expect(within(annual).queryByText("Standard sick")).toBeNull();
    expect(within(sick).getByText(/No carry-forward/)).toBeTruthy();
  });
});
