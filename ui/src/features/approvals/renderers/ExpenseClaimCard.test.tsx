import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../../auth/AuthContext";
import { ToastProvider } from "../../../components/Toast";
import { ExpenseClaimCard } from "./ExpenseClaimCard";
import type { Approval, ClaimDetail } from "../../../api/types";

/**
 * The expense-claim approval card (PRD-006a, for PRD-007's renderer registry).
 *
 * What matters here, in order:
 *
 *  1. the receipt renders **inline** and is **zoomable** — the S5 brief names both,
 *     and PRD-007 makes "images tappable to full screen" a mobile criterion;
 *  2. the approver sees what they need to decide (category, amount, project, limit
 *     status, per-line breakdown and the GL account each line will debit);
 *  3. every failure mode degrades rather than taking the inbox down. A card that
 *     throws would break the whole approvals screen, not just one row.
 *
 * `@testing-library/user-event` is not a dependency in `ui/` — `fireEvent` only.
 */

const fetchMock = vi.fn();

/** The blob URL the component asks for, so the test can assert it was revoked. */
let createdObjectUrls: string[] = [];
let revokedObjectUrls: string[] = [];

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

let claimResponse: { status: number; body: unknown } = { status: 200, body: null };
let receiptResponse: { status: number; body: unknown } = { status: 200, body: null };
let receiptRequests = 0;

function approval(): Approval {
  return {
    approval_id: "apr_1",
    subject_type: "expense_claim",
    subject_id: "clm_1",
    requested_by: "usr_filer",
    approver_user_id: "usr_manager",
    state: "pending",
    decision_comment: null,
    decided_by: null,
    decided_at: null,
    created_at: "2026-07-20T09:00:00.000Z",
    idempotency_key: null,
  };
}

function claimDetail(overrides: Partial<ClaimDetail> = {}): ClaimDetail {
  return {
    claim: {
      claim_id: "clm_1",
      employee_id: "emp_1",
      claim_date: "2026-07-18",
      description: "Client lunch, Bangsar",
      currency: "MYR",
      total_cents: 25_000,
      tax_cents: 0,
      status: "submitted",
      project_id: "prj_alpha",
      department_code: "operations",
      submitted_by: "usr_filer",
      submitted_at: "2026-07-20T09:00:00.000Z",
      approval_id: "apr_1",
      rejection_comment: null,
      rejected_at: null,
      entry_id: null,
      paid_entry_id: null,
      payment_reference: null,
      paid_at: null,
      created_at: "2026-07-20T08:00:00.000Z",
      updated_at: "2026-07-20T09:00:00.000Z",
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
  createdObjectUrls = [];
  revokedObjectUrls = [];
  receiptRequests = 0;
  claimResponse = { status: 200, body: claimDetail() };
  receiptResponse = { status: 200, body: null };

  // Patched onto the real URL rather than replacing the global: `{...URL}` loses
  // the constructor (class statics are non-enumerable), and react-router and
  // react-query both call `new URL(...)`.
  URL.createObjectURL = (blob: Blob) => {
    void blob;
    const url = `blob:mock/${createdObjectUrls.length}`;
    createdObjectUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedObjectUrls.push(url);
  };

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
          // The narrowest tier: the approver in the real flow holds no files
          // capability, so the card must never depend on one.
          role: "employee",
          status: "active",
        },
        tenant: { tenant_id: "biz_1", name: "Acme Inc", onboarded_at: "2026-01-01T00:00:00Z" },
        csrf_token: "csrf_1",
      });
    }
    if (path.includes("/receipt")) {
      receiptRequests += 1;
      if (receiptResponse.status !== 200) {
        return jsonResponse(receiptResponse.body ?? { error: "nope" }, receiptResponse.status);
      }
      // Duck-typed rather than a real Response: jsdom's `Blob` is not the one
      // undici's `Response` constructor accepts ("object.stream is not a
      // function"), and `getBlob` only ever touches `ok`, `status` and `blob()`.
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" }),
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
  URL.revokeObjectURL = realRevokeObjectURL;
});

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter>
            <ExpenseClaimCard approval={approval()} userName={(id) => id ?? "—"} />
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("the decision context", () => {
  it("shows the total, date, project and note", async () => {
    renderCard();
    // Scoped to the Total row: a one-line claim's header total and its single line
    // amount are legitimately the same string, so a bare text query is ambiguous.
    const total = await screen.findByText("Total");
    expect(total.nextElementSibling?.textContent).toMatch(/^MYR\s250\.00$/);
    expect(screen.getByText("Claim date").nextElementSibling?.textContent).toBe("2026-07-18");
    expect(screen.getByText("Project").nextElementSibling?.textContent).toBe("prj_alpha");
    expect(screen.getByText("Client lunch, Bangsar")).toBeTruthy();
    // The department id is rendered as its human label, not the raw registry id.
    expect(screen.getByText("Department").nextElementSibling?.textContent).toBe("Operations");
  });

  it("breaks the claim down by line, naming the GL account each one debits", async () => {
    renderCard();
    // An approver who can see where the money lands can catch a mis-categorised
    // claim before it reaches the books.
    expect(await screen.findByText("5200 Meals & Entertainment")).toBeTruthy();
    expect(screen.getByText("Meals")).toBeTruthy();
    expect(screen.getByText("Lunch with Zafrul")).toBeTruthy();
  });

  it("shows a mileage line's distance", async () => {
    const base = claimDetail();
    claimResponse = {
      status: 200,
      body: claimDetail({
        lines: [
          {
            ...base.lines[0]!,
            category_code: "mileage",
            category_name: "Mileage",
            category_kind: "mileage",
            account_code: "5500",
            account_name: "Mileage",
            distance_km: 42.5,
            amount_cents: 2_975,
          },
        ],
      }),
    };
    renderCard();
    expect(await screen.findByText("42.5 km")).toBeTruthy();
  });

  it("falls back to the claim's dimensions when a line has none", async () => {
    renderCard();
    // The line carries neither, so the claim's project and department are what is
    // in force — showing nothing would imply the expense is untagged when it is not.
    await screen.findByText("5200 Meals & Entertainment");
    expect(screen.getAllByText("prj_alpha").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Operations").length).toBeGreaterThan(0);
  });

  it("shows the limit status as a warning, with all three numbers", async () => {
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
    renderCard();
    // A warning, never a blocker — PRD-006 lets an over-limit claim submit, so the
    // approver is the one deciding and needs the numbers to do it.
    const warning = await screen.findByText(/is over its/);
    // The numbers only: `textContent` is not whitespace-normalized, and
    // Intl puts a non-breaking space after the currency code.
    expect(warning.textContent).toContain("200.00");
    expect(warning.textContent).toContain("250.00");
    expect(warning.textContent).toContain("50.00");
  });

  it("shows the journal entry once the claim has been posted", async () => {
    claimResponse = {
      status: 200,
      body: claimDetail({ claim: { ...claimDetail().claim, status: "approved", entry_id: "je_9" } }),
    };
    renderCard();
    expect(await screen.findByText(/je_9/)).toBeTruthy();
  });

  it("omits the tax row when there is no tax", async () => {
    renderCard();
    await screen.findByText("Total");
    // Shown only when there is tax to show — the line amounts are gross, so a
    // zero-tax row would be noise on every claim.
    expect(screen.queryByText("Of which tax")).toBeNull();
  });
});

describe("the receipt", () => {
  it("renders inline, fetched with credentials rather than as a bare img src", async () => {
    renderCard();
    const image = await screen.findByRole("img", { name: /Receipt for line 1/ });
    // A blob URL, not the API path: the session cookie is SameSite=Lax, so a
    // cross-origin <img src> would send no credential and 401.
    expect(image.getAttribute("src")).toBe("blob:mock/0");
    expect(receiptRequests).toBe(1);

    const receiptCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/receipt"))!;
    expect(String(receiptCall[0])).toContain("/v1/claims/clm_1/lines/1/receipt");
    expect((receiptCall[1] as RequestInit).credentials).toBe("include");
  });

  it("opens full screen when tapped and closes on Escape", async () => {
    renderCard();
    const trigger = await screen.findByRole("button", { name: /tap to view full screen/i });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Two images now: the thumbnail and the full-screen one.
    expect(screen.getAllByRole("img", { name: /Receipt for line 1/ })).toHaveLength(2);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on a backdrop tap but not on a tap on the image itself", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /tap to view full screen/i }));

    const dialog = screen.getByRole("dialog");
    const fullScreenImage = screen.getAllByRole("img", { name: /Receipt for line 1/ })[1]!;
    // Tapping the image must not dismiss it — that is how you look at a receipt.
    fireEvent.click(fullScreenImage);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.click(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("is a real button, so it is a keyboard and touch target", async () => {
    renderCard();
    const trigger = await screen.findByRole("button", { name: /tap to view full screen/i });
    expect(trigger.tagName).toBe("BUTTON");
    // PRD-007's mobile contract, pinned the way S4 pinned it: no fixed widths, and
    // a target at or above the 40px floor.
    expect(trigger.className).toContain("w-full");
    expect(trigger.className).toMatch(/min-h-(10|40)/);
  });

  it("revokes the object URL when the card unmounts", async () => {
    const view = renderCard();
    await screen.findByRole("img", { name: /Receipt for line 1/ });
    expect(createdObjectUrls).toEqual(["blob:mock/0"]);

    view.unmount();
    // An approvals inbox scrolls through many claims; leaking a blob per receipt
    // would grow without bound for as long as the tab is open.
    await waitFor(() => expect(revokedObjectUrls).toContain("blob:mock/0"));
  });

  it("says the receipt is unavailable when the file has been deleted", async () => {
    const base = claimDetail();
    claimResponse = {
      status: 200,
      body: claimDetail({
        lines: [
          {
            ...base.lines[0]!,
            receipt_filename: null,
            receipt_content_type: null,
            receipt_size_bytes: null,
          },
        ],
      }),
    };
    renderCard();
    expect(await screen.findByText("Receipt unavailable")).toBeTruthy();
    // Not even attempted — there is nothing to fetch.
    expect(receiptRequests).toBe(0);
  });

  it("says so when the receipt cannot be loaded, without breaking the card", async () => {
    receiptResponse = { status: 500, body: { error: "boom" } };
    renderCard();
    expect(await screen.findByText("Receipt could not be loaded")).toBeTruthy();
    // The rest of the card still renders — one bad image does not cost the
    // approver the context they need.
    expect(screen.getByText("5200 Meals & Entertainment")).toBeTruthy();
    expect(screen.getByText("Total").nextElementSibling?.textContent).toMatch(/^MYR\s250\.00$/);
  });

  it("offers a PDF receipt as a link instead of trying to render it", async () => {
    const base = claimDetail();
    claimResponse = {
      status: 200,
      body: claimDetail({
        lines: [
          {
            ...base.lines[0]!,
            receipt_filename: "invoice.pdf",
            receipt_content_type: "application/pdf",
          },
        ],
      }),
    };
    renderCard();
    const link = await screen.findByRole("link", { name: /Open invoice\.pdf/ });
    // Absolute against the API origin. A relative href would resolve against the
    // console's own origin and 404 — the two are never the same host in a real
    // deployment. Safe as a link because opening it is a top-level navigation,
    // which SameSite=Lax does send the cookie on.
    expect(link.getAttribute("href")).toBe(
      "http://localhost:8787/v1/claims/clm_1/lines/1/receipt",
    );
    // A PDF cannot render in an <img>, so no blob is fetched for it.
    expect(receiptRequests).toBe(0);
  });
});

describe("degrading rather than crashing", () => {
  it("renders an explanation when the claim cannot be read", async () => {
    // The API 404s a claim the caller may not see — including one that has since
    // been withdrawn. PRD-007 requires this to render rather than error.
    claimResponse = { status: 404, body: { error: "claim not found" } };
    renderCard();
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    // The reference is still shown, so the approver can ask about it.
    expect(screen.getByText("clm_1")).toBeTruthy();
  });

  it("shows a loading state rather than an empty card", () => {
    renderCard();
    expect(screen.getByRole("status", { name: "Loading claim" })).toBeTruthy();
  });

  it("renders a claim with no lines without throwing", async () => {
    claimResponse = { status: 200, body: claimDetail({ lines: [] }) };
    renderCard();
    // The header still renders; there is simply nothing to break it down into.
    expect((await screen.findByText("Total")).nextElementSibling?.textContent).toMatch(
      /^MYR\s250\.00$/,
    );
  });
});
