import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../../auth/AuthContext";
import { QuoteApprovalCard } from "./QuoteApprovalCard";
import type { Approval, QuoteDetail } from "../../../api/types";

/**
 * The `quote` approval card (PRD-004 P1).
 *
 * The approver's question is *"should we commit the company to this price?"*, so
 * the assertions are about the pricing facts being present and correct on the
 * card — total, validity, the lines, and above all the discount, which is the
 * number most likely to change the answer and the one that is easiest to bury.
 *
 * Same harness as the leave and claim cards: `fetch` is mocked rather than the
 * client, so the URL the card actually calls is under test too.
 * `@testing-library/user-event` is not a dependency here; nothing needs
 * interaction.
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
    subject_type: "quote",
    subject_id: "quote_1",
    requested_by: "usr_rep",
    approver_user_id: "usr_admin",
    state: "pending",
    decision_comment: null,
    decided_by: null,
    decided_at: null,
    created_at: "2026-08-10T09:00:00.000Z",
    idempotency_key: null,
    ...overrides,
  };
}

function quote(overrides: Partial<QuoteDetail> = {}): QuoteDetail {
  return {
    quote_id: "quote_1",
    quote_number: "Q2026-0042",
    customer_id: "cus_1",
    contact_id: null,
    deal_id: null,
    status: "draft",
    currency: "MYR",
    issue_date: "2026-08-10",
    expiry_date: "2026-09-10",
    subtotal_cents: 1_800_000,
    discount_total_cents: 200_000,
    tax_rate_bps: 600,
    tax_cents: 108_000,
    grand_total_cents: 1_908_000,
    prepared_by: "Farid",
    approved_by: null,
    notes: null,
    converted_invoice_id: null,
    created_at: "2026-08-10T09:00:00.000Z",
    updated_at: "2026-08-10T09:00:00.000Z",
    sent_at: null,
    accepted_at: null,
    version: 1,
    supersedes_quote_id: null,
    superseded_by_quote_id: null,
    first_viewed_at: null,
    last_viewed_at: null,
    view_count: 0,
    accepted_acceptance_id: null,
    sign_off_approval_id: null,
    sign_off_comment: null,
    lines: [
      {
        line_no: 1,
        item_name: "Platform licence",
        description: "12 months, 50 seats",
        note: null,
        quantity: 12,
        unit: "month",
        unit_cents: 150_000,
        discount_cents: 200_000,
        line_total_cents: 1_600_000,
      },
      {
        line_no: 2,
        item_name: "Onboarding",
        description: null,
        note: null,
        quantity: 1,
        unit: null,
        unit_cents: 200_000,
        discount_cents: 0,
        line_total_cents: 200_000,
      },
    ],
    ...overrides,
  };
}

let subject: QuoteDetail = quote();
let subjectStatus = 200;
let requestedPaths: string[] = [];

beforeEach(() => {
  subject = quote();
  subjectStatus = 200;
  requestedPaths = [];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.includes("/v1/auth/me")) {
      return jsonResponse({
        user: {
          user_id: "usr_admin",
          email: "boss@acme.com",
          display_name: "The Boss",
          role: "admin",
          status: "active",
        },
        tenant: { tenant_id: "biz_1", name: "Acme Inc", onboarded_at: "2026-01-01T00:00:00Z" },
        csrf_token: "csrf_1",
      });
    }
    if (path.includes("/v1/quotes/")) {
      requestedPaths.push(path);
      if (subjectStatus !== 200) return jsonResponse({ error: "quote not found" }, subjectStatus);
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <QuoteApprovalCard approval={a} userName={(id) => id ?? "—"} />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("QuoteApprovalCard", () => {
  it("fetches the subject named by the approval, not by any other id", async () => {
    renderCard(approval({ subject_id: "quote_99" }));
    await waitFor(() => expect(requestedPaths.length).toBeGreaterThan(0));
    expect(requestedPaths[0]).toContain("/v1/quotes/quote_99");
  });

  it("leads with the number, the total and the validity date", async () => {
    renderCard();
    expect(await screen.findByText("Q2026-0042")).toBeTruthy();

    // The figure the approver is actually being asked about.
    expect(screen.getByText("Total").nextElementSibling?.textContent).toContain("19,080.00");
    expect(screen.getByText("Subtotal").nextElementSibling?.textContent).toContain("18,000.00");
    expect(screen.getByText("Tax").nextElementSibling?.textContent).toContain("1,080.00");
    expect(screen.getByText("Valid until")).toBeTruthy();
  });

  it("calls out the discount as a share of list, not just an amount", async () => {
    renderCard();
    // 200,000 off a 2,000,000 gross is 10% — the fact most likely to change the
    // answer, and the one a per-line column would bury. Asserted on the banner's
    // own text: the amount alone also appears on a line item, so a bare
    // getByText would match twice.
    const banner = await screen.findByText(/Discounted by/);
    expect(banner.textContent).toContain("2,000.00");
    expect(banner.textContent).toContain("10% off list");
  });

  it("says nothing about discounts when there are none", async () => {
    subject = quote({
      discount_total_cents: 0,
      lines: [
        {
          line_no: 1,
          item_name: "Platform licence",
          description: null,
          note: null,
          quantity: 1,
          unit: null,
          unit_cents: 1_800_000,
          discount_cents: 0,
          line_total_cents: 1_800_000,
        },
      ],
    });
    renderCard();
    await screen.findByText("Q2026-0042");
    expect(screen.queryByText(/off list/)).toBeNull();
    expect(screen.queryByText(/Discounted by/)).toBeNull();
  });

  it("lists what is being sold, with quantities and line totals", async () => {
    renderCard();
    expect(await screen.findByText("Platform licence")).toBeTruthy();
    expect(screen.getByText("12 months, 50 seats")).toBeTruthy();
    expect(screen.getByText("Onboarding")).toBeTruthy();
    expect(screen.getByText("2 lines")).toBeTruthy();
    expect(screen.getByText(/12 month × /)).toBeTruthy();
  });

  it("says a quote with no expiry has none, rather than showing a blank", async () => {
    subject = quote({ expiry_date: null });
    renderCard();
    expect(await screen.findByText("No expiry set")).toBeTruthy();
  });

  it("renders in the quote's own currency, not a hardcoded one", async () => {
    subject = quote({ currency: "SGD" });
    renderCard();
    await screen.findByText("Q2026-0042");
    expect(screen.getByText("Total").nextElementSibling?.textContent).toContain("SGD");
  });

  it("renders as unavailable when the quote cannot be read", async () => {
    subjectStatus = 404;
    renderCard(approval({ subject_id: "quote_gone" }));
    // PRD-007's criterion: a subject that has gone away must not take the inbox
    // down with it.
    expect(await screen.findByText(/no longer available/i)).toBeTruthy();
    expect(screen.getByText("quote_gone")).toBeTruthy();
  });
});
