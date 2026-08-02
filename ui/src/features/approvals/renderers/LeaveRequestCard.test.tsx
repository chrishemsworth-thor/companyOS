import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../../auth/AuthContext";
import { LeaveRequestCard } from "./LeaveRequestCard";
import type { Approval, LeaveRequestDetail } from "../../../api/types";

/**
 * The `leave_request` approval card (PRD-006c).
 *
 * PRD-006c names four things the card must carry, and each has a test here:
 * dates, working days, **remaining balance after approval**, and **overlapping
 * team leave**. Plus PRD-007's cross-cutting criterion that a subject which has
 * gone away renders as unavailable rather than erroring.
 *
 * The card fetches its own subject, so the harness mocks `fetch` rather than the
 * client — that keeps the assertions honest about the URL the card actually calls,
 * which is the one thing a per-row-authorized route cannot afford to get wrong.
 *
 * `@testing-library/user-event` is not a dependency in this repo; nothing here
 * needs interaction anyway.
 */

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    approval_id: "apr_1",
    subject_type: "leave_request",
    subject_id: "lvr_1",
    requested_by: "usr_staff",
    approver_user_id: "usr_manager",
    state: "pending",
    decision_comment: null,
    decided_by: null,
    decided_at: null,
    created_at: "2027-02-20T09:00:00.000Z",
    idempotency_key: null,
    ...overrides,
  };
}

function detail(overrides: Partial<LeaveRequestDetail> = {}): LeaveRequestDetail {
  return {
    leave_request_id: "lvr_1",
    employee_id: "emp_1",
    employee_name: "Aisha Rahman",
    employee_user_id: "usr_staff",
    leave_type_code: "annual",
    start_date: "2027-03-01",
    end_date: "2027-03-03",
    start_half_day: false,
    end_half_day: false,
    working_days: 3,
    reason: "Family trip",
    attachment_file_id: null,
    state: "pending",
    approval_id: "apr_1",
    decided_at: null,
    cancelled_at: null,
    created_by: "usr_staff",
    created_at: "2027-02-20T09:00:00.000Z",
    updated_at: "2027-02-20T09:00:00.000Z",
    balance: {
      leave_type_code: "annual",
      leave_type_name: "Annual leave",
      entitlement_days: 14,
      carry_forward_days: 0,
      taken_days: 2,
      pending_days: 3,
      available_days: 9,
      entitlement_source: "policy",
    },
    balance_after_days: 9,
    team_overlaps: [],
    excluded_days: [],
    approval: null,
    ...overrides,
  };
}

/** What the mocked `GET /v1/leave/requests/:id` answers with. */
let subject: LeaveRequestDetail | null = detail();
let subjectStatus = 200;
/** Paths the card requested, so the URL itself can be asserted. */
let requestedPaths: string[] = [];

beforeEach(() => {
  subject = detail();
  subjectStatus = 200;
  requestedPaths = [];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.includes("/v1/auth/me")) {
      return jsonResponse({
        user: {
          user_id: "usr_manager",
          email: "manager@acme.com",
          display_name: "Manager",
          // The self-service tier, deliberately: this card has to work for an
          // approver holding no `people:read`, which is why its route is on the
          // `self` capability module.
          role: "employee",
          status: "active",
        },
        tenant: { tenant_id: "biz_1", name: "Acme Inc", onboarded_at: "2026-01-01T00:00:00Z" },
        csrf_token: "csrf_1",
      });
    }
    if (path.includes("/v1/leave/requests/")) {
      requestedPaths.push(path);
      if (subjectStatus !== 200) {
        return jsonResponse({ error: "leave request not found" }, subjectStatus);
      }
      return jsonResponse(subject);
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard(a: Approval = approval()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastlessProviders>
        <LeaveRequestCard approval={a} userName={(id) => id ?? "—"} />
      </ToastlessProviders>
    </QueryClientProvider>,
  );
}

/** AuthProvider needs a router for its redirect-on-401 path. */
function ToastlessProviders({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <AuthProvider>{children}</AuthProvider>
    </MemoryRouter>
  );
}

describe("LeaveRequestCard", () => {
  it("fetches the subject named by the approval, not by any other id", async () => {
    renderCard(approval({ subject_id: "lvr_99" }));
    await waitFor(() => expect(requestedPaths.length).toBeGreaterThan(0));
    expect(requestedPaths[0]).toContain("/v1/leave/requests/lvr_99");
  });

  it("shows the employee, type, dates and working days", async () => {
    renderCard();
    expect(await screen.findByText("Aisha Rahman")).toBeTruthy();
    expect(screen.getByText("Annual leave")).toBeTruthy();
    expect(screen.getByText("2027-03-01 → 2027-03-03")).toBeTruthy();
    // Asserted against the Working days row specifically — "3 days" could
    // otherwise match a balance figure elsewhere on the card.
    expect(screen.getByText("Working days").nextElementSibling?.textContent).toContain("3 days");
  });

  it("shows the remaining balance after approval (PRD-006c's named field)", async () => {
    renderCard();
    const row = await screen.findByText("Balance if approved");
    expect(row.nextElementSibling?.textContent).toContain("9 days left");
    // And the denominator, so "9" is legible as a proportion rather than a bare
    // number.
    expect(row.nextElementSibling?.textContent).toContain("of 14 days");
  });

  it("warns about overlapping team leave without implying it blocks anything", async () => {
    subject = detail({
      team_overlaps: [
        {
          leave_request_id: "lvr_2",
          employee_id: "emp_2",
          employee_name: "Ben Tan",
          leave_type_code: "annual",
          start_date: "2027-03-02",
          end_date: "2027-03-04",
          working_days: 3,
          state: "approved",
        },
      ],
    });
    renderCard();

    expect(await screen.findByText("Also off on these dates")).toBeTruthy();
    expect(screen.getByText(/Ben Tan/)).toBeTruthy();
    // Informative wording, never prohibitive — PRD-006 says warn, do not block.
    expect(screen.queryByText(/cannot|blocked|not allowed/i)).toBeNull();
  });

  it("omits the overlap block entirely when nobody else is off", async () => {
    renderCard();
    await screen.findByText("Aisha Rahman");
    expect(screen.queryByText("Also off on these dates")).toBeNull();
  });

  it("shows how many days were excluded, so the arithmetic is visible", async () => {
    subject = detail({
      start_date: "2027-03-01",
      end_date: "2027-03-07",
      working_days: 5,
      excluded_days: [
        { date: "2027-03-06", reason: "non_working_day" },
        { date: "2027-03-07", reason: "non_working_day" },
      ],
    });
    renderCard();
    const row = await screen.findByText("Working days");
    expect(row.nextElementSibling?.textContent).toContain("2 non-working days excluded");
  });

  it("marks a half-day span", async () => {
    subject = detail({ start_half_day: true });
    renderCard();
    expect(await screen.findByText("2027-03-01 (half day) → 2027-03-03")).toBeTruthy();
  });

  it("describes a single half day once rather than twice", async () => {
    subject = detail({
      start_date: "2027-03-01",
      end_date: "2027-03-01",
      start_half_day: true,
      end_half_day: true,
      working_days: 0.5,
    });
    renderCard();
    expect(await screen.findByText("2027-03-01 (half day)")).toBeTruthy();
  });

  it("formats a fractional day as 0.5, not 0.50", async () => {
    subject = detail({ working_days: 2.5, balance_after_days: 9.5 });
    renderCard();
    const row = await screen.findByText("Working days");
    expect(row.nextElementSibling?.textContent).toContain("2.5 days");
  });

  it("flags a negative balance rather than quietly showing a minus", async () => {
    subject = detail({ working_days: 12, balance_after_days: -3 });
    renderCard();
    const row = await screen.findByText("Balance if approved");
    // The class carries the signal a manager reads at a glance; the number alone
    // is easy to skim past.
    expect(row.nextElementSibling?.className).toContain("text-bad");
  });

  it("says so when the balance is a provisional default rather than policy", async () => {
    // While S6 is unmerged every entitlement is a fallback figure, and a manager
    // approving against one deserves to know it is not configured policy.
    subject = detail({
      balance: { ...detail().balance!, entitlement_source: "default" },
    });
    renderCard();
    expect(await screen.findByText(/Leave policy is not configured/i)).toBeTruthy();
  });

  it("does not mention policy configuration when policy exists", async () => {
    renderCard();
    await screen.findByText("Aisha Rahman");
    expect(screen.queryByText(/Leave policy is not configured/i)).toBeNull();
  });

  it("links to the supporting document when one is attached", async () => {
    subject = detail({ attachment_file_id: "fil_9" });
    renderCard();
    const link = (await screen.findByRole("link", {
      name: /supporting document/i,
    })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/v1/files/fil_9");
  });

  it("explains what approving means when the request is a cancellation", async () => {
    // The `cancellation_pending` state inverts the decision's meaning, so the
    // card has to say which way round it is or a manager will get it wrong.
    subject = detail({ state: "cancellation_pending" });
    renderCard();
    expect(await screen.findByText(/asking to cancel it/i)).toBeTruthy();
  });

  it("renders as unavailable rather than erroring when the subject is gone", async () => {
    // PRD-007's criterion. A cancelled request the approver can no longer read
    // lands here too.
    subjectStatus = 404;
    renderCard();
    expect(await screen.findByText(/no longer available/i)).toBeTruthy();
  });

  it("omits the reason row when there is no reason", async () => {
    subject = detail({ reason: null });
    renderCard();
    await screen.findByText("Aisha Rahman");
    expect(screen.queryByText("Reason")).toBeNull();
  });
});
