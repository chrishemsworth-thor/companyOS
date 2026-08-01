import { describe, it, expect } from "vitest";
import {
  linkableSubjectTypes,
  notificationTypeLabel,
  subjectLabel,
  subjectRoute,
} from "./subjectRoutes";

/**
 * The `subject_type` → console route map (PRD-007).
 *
 * The map lives in the console rather than on the API payload, so this is where
 * "where does this notification go" is pinned. The load-bearing case is the
 * *absence* of a route: a subject type this build cannot show must return null so
 * the caller renders it as unavailable, which is PRD-007's criterion about a
 * notification whose subject was deleted or never existed here.
 */

describe("subjectRoute", () => {
  it("routes the subject types this build can show", () => {
    expect(subjectRoute("quote", "qte_1")).toBe("/quotes/qte_1");
    expect(subjectRoute("invoice", "inv_1")).toBe("/invoices/inv_1");
  });

  it("returns null for a subject type this build has never heard of", () => {
    // A newer server can legitimately send one — the column has no CHECK.
    expect(subjectRoute("purchase_order", "po_1")).toBeNull();
  });

  it("returns null for a labelled type with no screen behind it", () => {
    // `other` is the generic approval — it has a label so a card can name it,
    // but nothing to navigate to. Linking a type before its page exists would
    // send the user to the catch-all redirect, which looks like a broken
    // notification, so a label must never imply a route.
    expect(subjectRoute("other", "oth_1")).toBeNull();
  });

  it("routes an expense claim to its read-only screen (S5)", () => {
    expect(subjectRoute("expense_claim", "clm_1")).toBe("/claims/clm_1");
  });

  it("routes a leave request to the detail screen S7 shipped", () => {
    // Not for the approvals card, which is self-sufficient — this is what the
    // "your leave was cancelled" notification needs somewhere to point at.
    expect(subjectRoute("leave_request", "lvr_1")).toBe("/leave/requests/lvr_1");
  });

  it("only claims routes that the router actually serves", () => {
    // A guard against the failure this map exists to prevent: a route added here
    // for a page nobody built. Kept as an explicit expected set so adding a
    // linkable type is a deliberate two-line change (map + this test).
    expect(linkableSubjectTypes().sort()).toEqual([
      "expense_claim",
      "invoice",
      "leave_request",
      "quote",
    ]);
  });
});

describe("subjectLabel", () => {
  it("labels the known types", () => {
    expect(subjectLabel("leave_request")).toBe("Leave request");
    expect(subjectLabel("expense_claim")).toBe("Expense claim");
  });

  it("humanizes an unknown type rather than showing a raw enum value", () => {
    expect(subjectLabel("purchase_order")).toBe("Purchase order");
  });
});

describe("notificationTypeLabel", () => {
  it("labels the four approval events", () => {
    expect(notificationTypeLabel("approval.requested")).toBe("Awaiting your decision");
    expect(notificationTypeLabel("approval.nudged")).toBe("Reminders");
  });

  it("falls back to the raw type so an unlabelled notification is not hidden", () => {
    expect(notificationTypeLabel("ticket.assigned")).toBe("ticket.assigned");
  });
});
