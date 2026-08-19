import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ExpenseClaimCard } from "./ExpenseClaimCard";
import { GenericApprovalCard } from "./GenericApprovalCard";
import { LeaveRequestCard } from "./LeaveRequestCard";
import { QuoteApprovalCard } from "./QuoteApprovalCard";
import {
  getApprovalRenderer,
  hasApprovalRenderer,
  registeredSubjectTypes,
} from "./registry";
import type { Approval } from "../../../api/types";

/**
 * The renderer registry (PRD-007 § "Type-specific context renderers").
 *
 * The criterion this file exists for: "given a new `subject_type` with no
 * registered renderer, then a generic fallback card renders rather than
 * crashing." That is not a hypothetical: S4 shipped zero type-specific renderers
 * and each later session adds one, so the fallback keeps being taken by any
 * subject type that arrives before its own card does. `expense_claim` (S5),
 * `leave_request` (S7) and `quote` (S9) have all since landed theirs — which
 * leaves `invoice` and `other` as the only types the fallback still serves, and
 * permanently so.
 */

afterEach(cleanup);

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    approval_id: "apr_1",
    subject_type: "expense_claim",
    subject_id: "clm_1",
    requested_by: "usr_requester",
    approver_user_id: "usr_approver",
    state: "pending",
    decision_comment: null,
    decided_by: null,
    decided_at: null,
    created_at: "2026-07-20T09:00:00.000Z",
    idempotency_key: null,
    ...overrides,
  };
}

const userName = (id: string | null) => (id === "usr_requester" ? "Aisha Rahman" : (id ?? "—"));

describe("getApprovalRenderer", () => {
  it("returns the generic fallback for a type with no registered renderer", () => {
    expect(getApprovalRenderer("purchase_order")).toBe(GenericApprovalCard);
  });

  it("returns the fallback for every type that still has no card", () => {
    // No invoice card is ever built (SESSION-PLAN C5) and `other` has nothing
    // type-specific to show, so for these two the fallback is the PERMANENT
    // answer rather than a placeholder waiting on a session.
    for (const type of ["invoice", "other"]) {
      expect(getApprovalRenderer(type)).toBe(GenericApprovalCard);
      expect(hasApprovalRenderer(type)).toBe(false);
    }
  });

  it("returns the purpose-built card for expense_claim (S5)", () => {
    expect(getApprovalRenderer("expense_claim")).toBe(ExpenseClaimCard);
    expect(hasApprovalRenderer("expense_claim")).toBe(true);
  });

  it("returns the purpose-built card for leave_request (S7)", () => {
    expect(getApprovalRenderer("leave_request")).toBe(LeaveRequestCard);
    expect(hasApprovalRenderer("leave_request")).toBe(true);
  });

  it("returns the purpose-built card for quote (S9)", () => {
    expect(getApprovalRenderer("quote")).toBe(QuoteApprovalCard);
    expect(hasApprovalRenderer("quote")).toBe(true);
  });

  it("registers exactly the subject types whose cards exist", () => {
    // Named exhaustively rather than just checking membership: this is the line
    // that catches a later session registering a card the plan does not expect.
    expect(registeredSubjectTypes().sort()).toEqual(["expense_claim", "leave_request", "quote"]);
  });

  it("never returns undefined, whatever it is handed", () => {
    for (const type of ["", "   ", "weird.type", "UPPER_CASE"]) {
      expect(getApprovalRenderer(type)).toBeTypeOf("function");
    }
  });
});

describe("GenericApprovalCard", () => {
  it("renders an unknown subject type without crashing", () => {
    render(<GenericApprovalCard approval={approval({ subject_type: "purchase_order" })} userName={userName} />);

    // Humanized, not a raw enum value. Asserted against the Type row
    // specifically — the label also appears in the fallback notice below it.
    expect(screen.getByText("Type").nextElementSibling?.textContent).toBe("Purchase order");
    expect(screen.getByText("clm_1")).toBeTruthy();
    expect(screen.getByText("Aisha Rahman")).toBeTruthy();
  });

  it("says the build has no detailed view when the subject has no route", () => {
    // `leave_request` rather than `expense_claim`: S5 gave claims both a card and
    // a screen, so a claim no longer reaches the fallback OR lacks a route.
    render(<GenericApprovalCard approval={approval({ subject_type: "leave_request" })} userName={userName} />);

    expect(screen.getByText(/no detailed view/i)).toBeTruthy();
  });

  it("offers a link to the subject when this build can route to it", () => {
    // `invoice` rather than `quote`: S9 gave quotes a card, so a quote no longer
    // reaches the fallback. `invoice` is routable and permanently card-less
    // (SESSION-PLAN C5), which is exactly the combination this asserts.
    render(
      <GenericApprovalCard
        approval={approval({ subject_type: "invoice", subject_id: "inv_9" })}
        userName={userName}
      />,
    );

    const link = screen.getByRole("link", { name: /open the invoice/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/invoices/inv_9");
  });

  it("names a programmatic requester rather than leaving the field blank", () => {
    render(<GenericApprovalCard approval={approval({ requested_by: null })} userName={userName} />);

    expect(screen.getByText("An integration")).toBeTruthy();
  });
});
