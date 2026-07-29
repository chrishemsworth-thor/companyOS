import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GenericApprovalCard } from "./GenericApprovalCard";
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
 * crashing." That is not a hypothetical — S4 ships zero type-specific renderers,
 * so *every* approval in this release takes the fallback path, and it will keep
 * being taken by any subject type that arrives before its own card does.
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

  it("returns the fallback for every type S4 knows about", () => {
    // S4 registers nothing: leave and claim cards ship with S7/S5, quote with S9,
    // and no invoice card is ever built (SESSION-PLAN C5).
    for (const type of ["leave_request", "expense_claim", "quote", "invoice", "other"]) {
      expect(getApprovalRenderer(type)).toBe(GenericApprovalCard);
      expect(hasApprovalRenderer(type)).toBe(false);
    }
  });

  it("registers no type-specific renderers in this session", () => {
    expect(registeredSubjectTypes()).toEqual([]);
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
    render(<GenericApprovalCard approval={approval({ subject_type: "expense_claim" })} userName={userName} />);

    expect(screen.getByText(/no detailed view/i)).toBeTruthy();
  });

  it("offers a link to the subject when this build can route to it", () => {
    render(
      <GenericApprovalCard
        approval={approval({ subject_type: "quote", subject_id: "qte_9" })}
        userName={userName}
      />,
    );

    const link = screen.getByRole("link", { name: /open the quote/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/quotes/qte_9");
  });

  it("names a programmatic requester rather than leaving the field blank", () => {
    render(<GenericApprovalCard approval={approval({ requested_by: null })} userName={userName} />);

    expect(screen.getByText("An integration")).toBeTruthy();
  });
});
