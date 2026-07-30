import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "../../auth/AuthContext";
import { ToastProvider } from "../../components/Toast";
import { ClaimDetail } from "./ClaimDetail";
import type { ClaimDetail as ClaimDetailType } from "../../api/types";

/**
 * The read-only claim screen (PRD-006a).
 *
 * This page exists to be the destination `subjectRoutes.ts` maps `expense_claim`
 * to — the approvals inbox and the notification bell both link here. So what is
 * worth pinning is that it answers the two questions a link-follower has ("what
 * was claimed" and "did it reach the books"), and that it does not become a
 * filing surface: PRD-006 puts creating and editing claims in P1.
 */

const fetchMock = vi.fn();
let claimResponse: { status: number; body: unknown } = { status: 200, body: null };

const realCreateObjectURL = URL.createObjectURL;

function claimDetail(overrides: Partial<ClaimDetailType> = {}): ClaimDetailType {
  return {
    claim: {
      claim_id: "clm_1",
      employee_id: "emp_1",
      claim_date: "2026-07-18",
      description: "Client lunch, Bangsar",
      currency: "MYR",
      total_cents: 25_000,
      tax_cents: 0,
      status: "approved",
      project_id: "prj_alpha",
      department_code: "operations",
      submitted_by: "usr_filer",
      submitted_at: "2026-07-20T09:00:00.000Z",
      approval_id: "apr_1",
      rejection_comment: null,
      rejected_at: null,
      entry_id: "je_7",
      paid_entry_id: null,
      payment_reference: null,
      paid_at: null,
      created_at: "2026-07-20T08:00:00.000Z",
      updated_at: "2026-07-21T09:00:00.000Z",
      ...overrides.claim,
    },
    lines: overrides.lines ?? [
      {
        line_no: 1,
        category_id: "ccat_meals",
        category_code: "meals",
        category_name: "Meals",
        category_kind: "standard",
        account_code: "5200",
        account_name: "Meals & Entertainment",
        description: "Lunch with Zafrul",
        distance_km: null,
        amount_cents: 25_000,
        tax_cents: 0,
        receipt_file_id: "file_1",
        receipt_filename: "receipt.jpg",
        receipt_content_type: "image/jpeg",
        receipt_size_bytes: 2048,
        project_id: null,
        department_code: null,
      },
    ],
    limit_warnings: overrides.limit_warnings ?? [],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  claimResponse = { status: 200, body: claimDetail() };
  URL.createObjectURL = () => "blob:mock/0";

  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.includes("/v1/auth/me")) {
      return jsonResponse({
        user: {
          user_id: "usr_filer",
          email: "aisha@acme.com",
          display_name: "Aisha",
          role: "employee",
          status: "active",
        },
        tenant: { tenant_id: "biz_1", name: "Acme Inc", onboarded_at: "2026-01-01T00:00:00Z" },
        csrf_token: "csrf_1",
      });
    }
    if (path.includes("/receipt")) {
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["jpeg"], { type: "image/jpeg" }),
      } as unknown as Response;
    }
    if (path.includes("/v1/claims/")) {
      if (claimResponse.status !== 200) {
        return jsonResponse(claimResponse.body ?? { error: "not found" }, claimResponse.status);
      }
      return jsonResponse(claimResponse.body);
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  URL.createObjectURL = realCreateObjectURL;
});

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={["/claims/clm_1"]}>
            <Routes>
              <Route path="/claims/:id" element={<ClaimDetail />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ClaimDetail", () => {
  it("shows the claim, its status and the journal entry it posted", async () => {
    renderScreen();
    expect(await screen.findByText("clm_1")).toBeTruthy();
    expect(screen.getByText("approved")).toBeTruthy();
    // The proof it reached the books, which is the point of PRD-006a.
    expect(screen.getByText("je_7")).toBeTruthy();
    expect(screen.getByText("Total").nextElementSibling?.textContent).toMatch(/^MYR\s250\.00$/);
  });

  it("breaks the claim into lines with their GL accounts and receipts", async () => {
    renderScreen();
    expect(await screen.findByText("5200 Meals & Entertainment")).toBeTruthy();
    expect(screen.getByText("Lunch with Zafrul")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /tap to view full screen/i }),
    ).toBeTruthy();
  });

  it("says an untagged claim is Unallocated rather than leaving it blank", async () => {
    claimResponse = {
      status: 200,
      body: claimDetail({ claim: { ...claimDetail().claim, project_id: null } }),
    };
    renderScreen();
    // The same principle as PRD-001a's rollup: untagged is a fact, not a gap.
    expect(await screen.findByText("Unallocated")).toBeTruthy();
  });

  it("says 'Not posted' before approval", async () => {
    claimResponse = {
      status: 200,
      body: claimDetail({ claim: { ...claimDetail().claim, status: "submitted", entry_id: null } }),
    };
    renderScreen();
    expect(await screen.findByText("Not posted")).toBeTruthy();
  });

  it("shows the rejection reason on a returned claim", async () => {
    claimResponse = {
      status: 200,
      body: claimDetail({
        claim: {
          ...claimDetail().claim,
          status: "rejected",
          entry_id: null,
          rejection_comment: "Receipt is illegible",
          rejected_at: "2026-07-21T02:00:00.000Z",
        },
      }),
    };
    renderScreen();
    // The one thing the employee actually needs when a claim comes back.
    expect(await screen.findByText("Returned to you")).toBeTruthy();
    expect(screen.getByText("Receipt is illegible")).toBeTruthy();
  });

  it("shows the limit breach", async () => {
    claimResponse = {
      status: 200,
      body: claimDetail({
        limit_warnings: [
          {
            category_id: "ccat_meals",
            category_code: "meals",
            category_name: "Meals",
            limit_cents: 20_000,
            claimed_cents: 25_000,
            over_by_cents: 5_000,
          },
        ],
      }),
    };
    renderScreen();
    expect(await screen.findByText(/is over its/)).toBeTruthy();
  });

  it("shows the reimbursement once it has been paid", async () => {
    claimResponse = {
      status: 200,
      body: claimDetail({
        claim: {
          ...claimDetail().claim,
          status: "paid",
          paid_entry_id: "je_8",
          payment_reference: "MBB-004",
          paid_at: "2026-07-31T02:00:00.000Z",
        },
      }),
    };
    renderScreen();
    expect(await screen.findByText("MBB-004")).toBeTruthy();
    expect(screen.getByText("paid")).toBeTruthy();
  });

  it("surfaces a 404 as an error state rather than a blank page", async () => {
    // What a colleague following a stale link gets — the API answers 404 for a
    // claim that is not theirs, not their decision, and not finance's.
    claimResponse = { status: 404, body: { error: "claim not found" } };
    renderScreen();
    expect(await screen.findByText(/claim not found/i)).toBeTruthy();
  });

  it("offers no way to edit or submit — this release is read-only", async () => {
    renderScreen();
    await screen.findByText("clm_1");
    // PRD-006 puts filing and editing from the console in P1. If a later session
    // adds them, this assertion is the reminder to update the page's own doc
    // comment and the route's guard rather than letting them arrive silently.
    for (const label of [/submit/i, /withdraw/i, /reimburse/i, /save/i, /edit/i]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });
});
