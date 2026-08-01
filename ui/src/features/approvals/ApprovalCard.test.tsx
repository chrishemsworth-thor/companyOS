import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ApprovalCard, formatAge } from "./ApprovalCard";
import type { Approval } from "../../api/types";

/**
 * The approval card shell, and PRD-007's mobile requirement.
 *
 * **What this file can and cannot prove.** PRD-007's mobile criteria are visual —
 * "an approval can be reviewed and decided without horizontal scrolling at
 * 375px". jsdom has no layout engine: every element reports zero width and
 * nothing is ever laid out, so no assertion here can measure an overflow. What is
 * testable is the *contract* that produces the result — that the card declares no
 * fixed width, that the decision controls are full-width and stacked below `sm`,
 * and that touch targets are the 40px the design system's `icon`/`md` sizes give.
 * The rendered outcome still wants one manual pass in a 375px viewport, and that
 * is recorded in the session notes rather than papered over here.
 */

afterEach(cleanup);

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    approval_id: "apr_1",
    // A type with no registered renderer, so these tests exercise the shell plus
    // the generic fallback. Was `expense_claim` until S5 gave claims a real card,
    // which fetches — the shell's own behaviour is what is under test here.
    subject_type: "leave_request",
    subject_id: "clm_1",
    requested_by: "usr_aisha",
    approver_user_id: "usr_me",
    state: "pending",
    decision_comment: null,
    decided_by: null,
    decided_at: null,
    created_at: new Date("2026-07-27T12:00:00.000Z").toISOString(),
    idempotency_key: null,
    ...overrides,
  };
}

const userName = (id: string | null) => (id === "usr_aisha" ? "Aisha Rahman" : (id ?? "—"));

describe("formatAge", () => {
  const now = new Date("2026-07-29T12:00:00.000Z").getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("uses the coarsest honest unit", () => {
    expect(formatAge(ago(30_000), now)).toBe("just now");
    expect(formatAge(ago(5 * 60_000), now)).toBe("5m");
    expect(formatAge(ago(3 * 60 * 60_000), now)).toBe("3h");
    expect(formatAge(ago(11 * 24 * 60 * 60_000), now)).toBe("11d");
  });

  it("rounds down, so an age is never overstated", () => {
    // 59 minutes is not "1h" — a request that has waited under the hour should
    // not read as though it has waited longer.
    expect(formatAge(ago(59 * 60_000 + 59_000), now)).toBe("59m");
    expect(formatAge(ago(23 * 60 * 60_000 + 59 * 60_000), now)).toBe("23h");
  });

  it("never reports a negative age from a clock skew", () => {
    // The server stamps created_at; a client clock a few seconds behind must not
    // render "-1m".
    expect(formatAge(ago(-30_000), now)).toBe("just now");
  });

  it("returns empty for an unparseable timestamp rather than NaN", () => {
    expect(formatAge("not a date", now)).toBe("");
  });
});

describe("the card shell", () => {
  it("shows the subject, requester and age without a type-specific renderer", () => {
    render(<ApprovalCard approval={approval()} userName={userName} />);

    expect(screen.getByRole("heading").textContent).toBe("Leave request");
    expect(screen.getByText("from Aisha Rahman")).toBeTruthy();
    // Two days old.
    expect(screen.getByText("2d")).toBeTruthy();
  });

  it("offers no decision controls without an onDecide handler", () => {
    render(<ApprovalCard approval={approval()} userName={userName} />);

    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/add a comment/i)).toBeNull();
  });

  it("shows a decision comment when the approval carries one", () => {
    render(
      <ApprovalCard
        approval={approval({ state: "rejected", decision_comment: "Receipt is illegible" })}
        userName={userName}
      />,
    );

    expect(screen.getByText("Receipt is illegible")).toBeTruthy();
    expect(screen.getByText("rejected")).toBeTruthy();
  });

  it("does not badge a pending approval with its own state", () => {
    // "pending" on every card in the queue is noise — the queue is pending by
    // definition. The age is the signal that matters there.
    render(<ApprovalCard approval={approval()} userName={userName} />);

    expect(screen.queryByText("pending")).toBeNull();
  });

  it("flags a request that has been waiting too long", () => {
    const stale = render(
      <ApprovalCard
        approval={approval({
          created_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
        })}
        userName={userName}
      />,
    );
    // The age chip turns from neutral to bad past the staleness threshold, which
    // is what makes "age prominently displayed" mean something on a long list.
    expect(stale.container.querySelector(".text-bad")).not.toBeNull();
    cleanup();

    const fresh = render(
      <ApprovalCard
        approval={approval({ created_at: new Date(Date.now() - 60_000).toISOString() })}
        userName={userName}
      />,
    );
    expect(fresh.container.querySelector(".text-bad")).toBeNull();
  });
});

describe("mobile contract (PRD-007's 375px requirement)", () => {
  it("stacks the decision controls and makes them full width below sm", () => {
    render(<ApprovalCard approval={approval()} userName={userName} onDecide={() => {}} />);

    for (const name of [/approve/i, /reject/i]) {
      const button = screen.getByRole("button", { name });
      // `w-full` at the base breakpoint, `sm:w-auto` above it: a thumb-sized
      // target on a phone, a normal button on a desk.
      expect(button.className).toContain("w-full");
      expect(button.className).toContain("sm:w-auto");
      // `h-10` — 40px, the design system's md height. Below ~40px a target
      // becomes a mis-tap on a phone.
      expect(button.className).toContain("h-10");
    }
  });

  it("declares no fixed width anywhere on the card", () => {
    // The mechanism behind "no horizontal scrolling": nothing on the card asserts
    // a width the viewport has to accommodate. jsdom cannot measure the result,
    // but it can prove the cause is absent.
    const { container } = render(
      <ApprovalCard approval={approval()} userName={userName} onDecide={() => {}} />,
    );

    const offenders = [...container.querySelectorAll<HTMLElement>("*")].filter((el) =>
      // Tailwind fixed widths (w-96, w-[22rem]) and fixed min-widths.
      // Deliberately excluded: w-full, max-w-*, size-*, and min-w-0 — that last
      // one is what ALLOWS a flex child to shrink, so it is the opposite of an
      // offender.
      /(^|\s)(w-\d|w-\[|min-w-\[|min-w-[1-9])/.test(el.className || ""),
    );

    expect(offenders.map((el) => el.className)).toEqual([]);
  });

  it("keeps the requester line from forcing the header wider than the viewport", () => {
    // A long name must wrap or truncate rather than push the age chip off screen.
    const { container } = render(
      <ApprovalCard
        approval={approval()}
        userName={() => "Muhammad Nur Aisyah binti Abdul Rahman Al-Hakim"}
      />,
    );

    const header = container.querySelector("header")!;
    // `flex-wrap` on the header plus `min-w-0` on the text column is what lets
    // the flex child actually shrink — without min-w-0 a long string sets the
    // flex basis and nothing can compress it.
    expect(header.className).toContain("flex-wrap");
    expect(header.querySelector(".min-w-0")).not.toBeNull();
  });
});
