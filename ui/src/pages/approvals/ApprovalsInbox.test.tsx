import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../auth/AuthContext";
import { ToastProvider } from "../../components/Toast";
import { ApprovalsInbox } from "./ApprovalsInbox";
import type { Approval } from "../../api/types";

/**
 * The approvals inbox (PRD-007 § "P0 — Approvals inbox" and § "P0 — Requester
 * visibility").
 *
 * Covers every acceptance criterion in those two sections:
 *
 *  - three types in one list, each with correct type-specific context
 *  - approving removes the item immediately
 *  - a 409 rolls the optimistic update back and explains that it was already handled
 *  - rejecting without a comment is blocked inline
 *  - a user with nothing pending gets a genuine empty state
 *  - an unregistered `subject_type` falls back rather than crashing
 *  - a requester sees the approver's name and elapsed time, can nudge, can cancel
 *
 * The API is stubbed at `fetch`, so this exercises the real components and the
 * real React Query wiring against the response shapes the Workers suite pins.
 */

const fetchMock = vi.fn();

const NOW = new Date("2026-07-29T12:00:00.000Z").getTime();

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    approval_id: "apr_1",
    subject_type: "expense_claim",
    subject_id: "clm_1",
    requested_by: "usr_aisha",
    approver_user_id: "usr_me",
    state: "pending",
    decision_comment: null,
    decided_by: null,
    decided_at: null,
    // 2 days old.
    created_at: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(),
    idempotency_key: null,
    ...overrides,
  };
}

/** What the stub returns per tab query, and what it recorded. */
let awaiting: Approval[] = [];
let mine: Approval[] = [];
let decisionStatus = 200;
const posts: { path: string; body: unknown }[] = [];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  awaiting = [];
  mine = [];
  decisionStatus = 200;
  posts.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (path.includes("/v1/auth/me")) {
      return jsonResponse({
        user: {
          user_id: "usr_me",
          email: "manager@acme.com",
          display_name: "Manager",
          role: "operator",
          status: "active",
        },
        tenant: { tenant_id: "biz_1", name: "Acme Inc", onboarded_at: "2026-01-01T00:00:00Z" },
        csrf_token: "csrf_1",
      });
    }
    if (path.includes("/v1/meta/users")) {
      return jsonResponse({
        users: [
          { user_id: "usr_aisha", display_name: "Aisha Rahman", email: "aisha@acme.com" },
          { user_id: "usr_chen", display_name: "Chen Wei", email: "chen@acme.com" },
          { user_id: "usr_me", display_name: "Manager", email: "manager@acme.com" },
        ],
      });
    }
    if (method === "POST") {
      posts.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const decided = path.match(/\/v1\/approvals\/([^/]+)\/(approve|reject)$/);
      if (decided && decisionStatus !== 200) {
        return jsonResponse({ error: "approval is approved and cannot be approved" }, decisionStatus);
      }
      if (decided) {
        // A decided approval stops being pending, so `?state=pending` would no
        // longer return it. Modelled here because otherwise the refetch that
        // follows the optimistic removal puts the row straight back — and the
        // test would be asserting the stub's behaviour, not the page's.
        awaiting = awaiting.filter((a) => a.approval_id !== decided[1]);
      }
      if (path.endsWith("/nudge")) return jsonResponse({ approval_id: "apr_1" }, 202);
      return jsonResponse({ ok: true });
    }
    if (path.includes("/v1/leave/requests/")) {
      // S7's leave card fetches its own subject. The inbox shell knows nothing
      // about this — which is the property being demonstrated — but the stub has
      // to answer it, or the card renders its unavailable state.
      const id = path.split("/v1/leave/requests/")[1]!;
      return jsonResponse({
        leave_request_id: id,
        employee_id: "emp_1",
        employee_name: "Aisha Rahman",
        employee_user_id: "usr_aisha",
        leave_type_code: "annual",
        start_date: "2027-03-01",
        end_date: "2027-03-03",
        start_half_day: false,
        end_half_day: false,
        working_days: 3,
        reason: null,
        attachment_file_id: null,
        state: "pending",
        approval_id: "apr_1",
        decided_at: null,
        cancelled_at: null,
        created_by: "usr_aisha",
        created_at: "2027-02-20T09:00:00.000Z",
        updated_at: "2027-02-20T09:00:00.000Z",
        balance: {
          leave_type_code: "annual",
          leave_type_name: "Annual leave",
          entitlement_days: 14,
          carry_forward_days: 0,
          taken_days: 0,
          pending_days: 3,
          available_days: 11,
          entitlement_source: "policy",
        },
        balance_after_days: 11,
        team_overlaps: [],
        excluded_days: [],
        approval: null,
      });
    }
    if (path.includes("/v1/approvals")) {
      // `requester=me` is the My-requests tab; everything else is the queue.
      const items = path.includes("requester=me") ? mine : awaiting;
      return jsonResponse({ items, next_cursor: null });
    }
    throw new Error(`unexpected fetch: ${method} ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderInbox() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={["/approvals"]}>
            <ApprovalsInbox />
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The card for an approval, found via its reference id. */
function cardFor(subjectId: string): HTMLElement {
  const ref = screen.getByText(subjectId);
  const card = ref.closest("article");
  if (!card) throw new Error(`no card for ${subjectId}`);
  return card as HTMLElement;
}

describe("Awaiting me", () => {
  it("lists approvals of three types in one list with type-specific context", async () => {
    // The criterion, and since S7 it is genuinely mixed: `leave_request` takes a
    // purpose-built card while `expense_claim` (S5) and `quote` (S9) still take
    // the generic one. The shell renders all three without knowing which is
    // which, which is the property PRD-007 asks for.
    awaiting = [
      approval({ approval_id: "apr_1", subject_type: "leave_request", subject_id: "lvr_1" }),
      approval({
        approval_id: "apr_2",
        subject_type: "expense_claim",
        subject_id: "clm_2",
        requested_by: "usr_chen",
      }),
      approval({ approval_id: "apr_3", subject_type: "quote", subject_id: "qte_3" }),
    ];
    renderInbox();

    await screen.findByText("clm_2");
    // By heading: the subject label also appears in the generic card's Type row,
    // so a bare getByText would match twice.
    expect(within(cardFor("clm_2")).getByRole("heading").textContent).toBe("Expense claim");
    expect(within(cardFor("qte_3")).getByRole("heading").textContent).toBe("Quote");

    // The leave card carries no reference row, so it is located by its heading
    // rather than by a subject id — the purpose-built cards show real content
    // instead of an opaque id, which is the whole point of registering one.
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toContain("Leave request");
    // And its own fetched content is on the page, from a card the shell knows
    // nothing about.
    expect(await screen.findByText("2027-03-01 → 2027-03-03")).toBeTruthy();

    // Requesters are resolved to names, not raw usr_ ids.
    expect(within(cardFor("clm_2")).getByText("from Chen Wei")).toBeTruthy();
  });

  it("shows age prominently and preserves the API's oldest-first order", async () => {
    awaiting = [
      approval({
        approval_id: "apr_old",
        subject_id: "clm_old",
        created_at: new Date(NOW - 11 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      approval({
        approval_id: "apr_new",
        subject_id: "clm_new",
        created_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
      }),
    ];
    renderInbox();

    await screen.findByText("clm_old");
    expect(within(cardFor("clm_old")).getByText("11d")).toBeTruthy();
    expect(within(cardFor("clm_new")).getByText("30m")).toBeTruthy();

    // Oldest first: the thing that has waited longest is blocking somebody.
    const refs = screen.getAllByText(/^clm_(old|new)$/).map((el) => el.textContent);
    expect(refs).toEqual(["clm_old", "clm_new"]);
  });

  it("removes the item immediately on approve", async () => {
    awaiting = [approval({ subject_id: "clm_1" })];
    renderInbox();
    await screen.findByText("clm_1");

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(screen.queryByText("clm_1")).toBeNull());
    expect(posts.map((p) => p.path.split("/v1")[1])).toEqual(["/approvals/apr_1/approve"]);
  });

  it("sends an optional comment with an approval", async () => {
    awaiting = [approval()];
    renderInbox();
    await screen.findByText("clm_1");

    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
      target: { value: "Checked against the PO" },
    });
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ comment: "Checked against the PO" });
  });

  it("blocks a rejection with no comment, inline, without calling the API", async () => {
    awaiting = [approval()];
    renderInbox();
    await screen.findByText("clm_1");

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/a comment is required to reject/i)).toBeTruthy();
    // The card is still there and nothing was sent.
    expect(screen.getByText("clm_1")).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it("rejects once a comment is supplied, and clears the inline error", async () => {
    awaiting = [approval()];
    renderInbox();
    await screen.findByText("clm_1");

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
      target: { value: "Receipt is illegible" },
    });
    // The error clears as soon as the problem is fixed, not on the next submit.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.path).toContain("/reject");
    expect(posts[0]!.body).toEqual({ comment: "Receipt is illegible" });
  });

  it("rolls the optimistic update back and explains a 409", async () => {
    // Two managers open the same request; the other one decides first. Silently
    // dropping the item would leave this manager believing they decided something
    // they did not.
    decisionStatus = 409;
    awaiting = [approval({ subject_id: "clm_1" })];
    renderInbox();
    await screen.findByText("clm_1");

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(await screen.findByText("Already handled")).toBeTruthy();
    expect(screen.getByText(/somebody else decided this request first/i)).toBeTruthy();
    // Back on screen — the rollback.
    expect(screen.getByText("clm_1")).toBeTruthy();
  });

  it("surfaces a non-409 failure without claiming somebody else decided", async () => {
    decisionStatus = 500;
    awaiting = [approval()];
    renderInbox();
    await screen.findByText("clm_1");

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(await screen.findByText("Could not record your decision")).toBeTruthy();
    expect(screen.queryByText("Already handled")).toBeNull();
  });

  it("renders a genuine empty state when nothing is pending", async () => {
    renderInbox();

    expect(await screen.findByText(/nothing needs your decision/i)).toBeTruthy();
  });

  it("does not crash on a subject_type with no registered renderer", async () => {
    // PRD-007's fallback criterion, through the real page rather than the
    // registry in isolation.
    awaiting = [approval({ subject_type: "purchase_order", subject_id: "po_1" })];
    renderInbox();

    await screen.findByText("po_1");
    expect(within(cardFor("po_1")).getByRole("heading").textContent).toBe("Purchase order");
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
  });
});

describe("filters", () => {
  it("filters by type", async () => {
    // Two types that both take the generic card, so this stays a test of the
    // filter rather than of any renderer's internals.
    awaiting = [
      approval({ approval_id: "apr_1", subject_type: "quote", subject_id: "qte_1" }),
      approval({ approval_id: "apr_2", subject_type: "expense_claim", subject_id: "clm_2" }),
    ];
    renderInbox();
    await screen.findByText("qte_1");

    fireEvent.change(screen.getByLabelText("Filter by type"), {
      target: { value: "expense_claim" },
    });

    await waitFor(() => expect(screen.queryByText("qte_1")).toBeNull());
    expect(screen.getByText("clm_2")).toBeTruthy();
  });

  it("searches by requester name", async () => {
    awaiting = [
      approval({ approval_id: "apr_1", subject_id: "clm_1", requested_by: "usr_aisha" }),
      approval({ approval_id: "apr_2", subject_id: "clm_2", requested_by: "usr_chen" }),
    ];
    renderInbox();
    await screen.findByText("clm_1");

    fireEvent.change(screen.getByLabelText("Search by requester name"), {
      target: { value: "chen" },
    });

    await waitFor(() => expect(screen.queryByText("clm_1")).toBeNull());
    expect(screen.getByText("clm_2")).toBeTruthy();
  });

  it("distinguishes 'no matches' from 'nothing waiting'", async () => {
    // A filtered-empty list must not read like an empty queue, or a user will
    // conclude they have no work when they have plenty.
    awaiting = [approval({ subject_id: "clm_1" })];
    renderInbox();
    await screen.findByText("clm_1");

    fireEvent.change(screen.getByLabelText("Search by requester name"), {
      target: { value: "nobody by that name" },
    });

    expect(await screen.findByText(/nothing matches those filters/i)).toBeTruthy();
    expect(screen.queryByText(/nothing needs your decision/i)).toBeNull();
  });
});

describe("My requests", () => {
  it("shows the approver's name and how long it has been waiting", async () => {
    mine = [
      approval({
        approval_id: "apr_mine",
        subject_id: "clm_mine",
        requested_by: "usr_me",
        approver_user_id: "usr_chen",
        created_at: new Date(NOW - 6 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "My requests" }));

    await screen.findByText("clm_mine");
    const card = cardFor("clm_mine");
    expect(within(card).getByText("Chen Wei")).toBeTruthy();
    expect(within(card).getByText("6d")).toBeTruthy();
  });

  it("offers no decision controls on your own request", async () => {
    // Even when you are somehow the approver: the API blocks self-approval for
    // non-admins, so offering the button would be a trap.
    mine = [approval({ requested_by: "usr_me", approver_user_id: "usr_me" })];
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "My requests" }));
    await screen.findByText("clm_1");

    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^reject$/i })).toBeNull();
  });

  it("nudges the approver", async () => {
    mine = [approval({ approval_id: "apr_mine", requested_by: "usr_me" })];
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "My requests" }));
    fireEvent.click(await screen.findByRole("button", { name: /nudge/i }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.path).toContain("/v1/approvals/apr_mine/nudge");
    expect(await screen.findByText("Reminder sent")).toBeTruthy();
  });

  it("explains the 24h cooldown rather than reading like a bug", async () => {
    mine = [approval({ requested_by: "usr_me" })];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/v1/auth/me")) {
        return jsonResponse({
          user: {
            user_id: "usr_me",
            email: "m@acme.com",
            display_name: "Manager",
            role: "operator",
            status: "active",
          },
          tenant: { tenant_id: "biz_1", name: "Acme", onboarded_at: "2026-01-01T00:00:00Z" },
          csrf_token: "csrf_1",
        });
      }
      if (path.includes("/v1/meta/users")) return jsonResponse({ users: [] });
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        return jsonResponse({ error: "already nudged", code: "rate_limited" }, 429);
      }
      return jsonResponse({ items: mine, next_cursor: null });
    });
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "My requests" }));
    fireEvent.click(await screen.findByRole("button", { name: /nudge/i }));

    expect(await screen.findByText("Already reminded")).toBeTruthy();
    expect(screen.getByText(/in the last 24 hours/i)).toBeTruthy();
  });

  it("withdraws a pending request", async () => {
    mine = [approval({ approval_id: "apr_mine", requested_by: "usr_me" })];
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "My requests" }));
    fireEvent.click(await screen.findByRole("button", { name: /withdraw/i }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.path).toContain("/v1/approvals/apr_mine/cancel");
    expect(await screen.findByText("Request withdrawn")).toBeTruthy();
  });

  it("offers neither nudge nor withdraw once a request is decided", async () => {
    mine = [
      approval({
        requested_by: "usr_me",
        state: "rejected",
        decision_comment: "Receipt is illegible",
        decided_by: "usr_chen",
      }),
    ];
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "My requests" }));
    await screen.findByText("clm_1");

    expect(screen.queryByRole("button", { name: /nudge/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
    // The rejection reason is what the requester came here for.
    expect(screen.getByText("Receipt is illegible")).toBeTruthy();
  });

  it("has its own empty state, not the queue's", async () => {
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "My requests" }));

    expect(await screen.findByText(/you have not raised anything for approval/i)).toBeTruthy();
  });
});

describe("History", () => {
  it("shows decided approvals only", async () => {
    awaiting = [
      approval({ approval_id: "apr_p", subject_id: "clm_pending", state: "pending" }),
      approval({
        approval_id: "apr_d",
        subject_id: "clm_decided",
        state: "approved",
        decided_by: "usr_me",
      }),
    ];
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "History" }));

    await screen.findByText("clm_decided");
    // A pending item is not history.
    expect(screen.queryByText("clm_pending")).toBeNull();
  });

  it("offers no decision controls", async () => {
    awaiting = [approval({ state: "approved", decided_by: "usr_me" })];
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "History" }));
    await screen.findByText("clm_1");

    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
  });

  it("has its own empty state", async () => {
    renderInbox();

    fireEvent.click(await screen.findByRole("tab", { name: "History" }));

    expect(await screen.findByText(/no decisions yet/i)).toBeTruthy();
  });
});

describe("tabs", () => {
  it("defaults to Awaiting me", async () => {
    renderInbox();

    const tab = await screen.findByRole("tab", { name: "Awaiting me" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });
});
