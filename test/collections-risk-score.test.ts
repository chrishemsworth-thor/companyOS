import { describe, it, expect } from "vitest";
import {
  assessRisk,
  fallbackDecision,
  latenessPoints,
  persistencePoints,
  reliabilityBand,
  RELIABILITY_FACTORS,
  type AgentStateSummary,
  type CollectionsContext,
  type PaymentReliability,
} from "../src/agents/decision";

/**
 * The deterministic risk score.
 *
 * The old formula was `min(100, days * 5 + reminders * 10)`, which hit the
 * ceiling at 20 days and ignored the payment record entirely — so a 20-day-late
 * invoice from a customer who had paid twelve of twelve on time scored 100, the
 * same as a 200-day write-off from somebody who had never paid at all. The eval
 * harness found it; this is the replacement.
 *
 * The score does not decide anything on its own — it is reported on the decision
 * and on `customer.risk_flagged`, and the *action* is decided separately and
 * guarded. That is why re-tuning it is safe, and why these tests assert
 * ORDERING and BANDS rather than exact numbers wherever the exact number is not
 * the point.
 */

const state = (over: Partial<AgentStateSummary> = {}): AgentStateSummary => ({
  escalation_stage: "none",
  reminders_sent: 0,
  last_contact: null,
  ...over,
});

function context(
  daysOverdue: number,
  reliability: PaymentReliability | null,
  invoices = 1,
): CollectionsContext {
  return {
    customer: { customer_id: "cust_1", name: "Test Sdn Bhd", email: "a@b.example", phone: null },
    billing_contact: null,
    payment_reliability: reliability,
    health: null,
    overdue_invoices: Array.from({ length: invoices }, (_, i) => ({
      invoice_id: `inv_${i}`,
      amount_due_cents: 100_000,
      currency: "MYR",
      // The first invoice is the oldest; the score keys off the maximum.
      due_date: "2026-06-01",
      days_overdue: i === 0 ? daysOverdue : Math.max(0, daysOverdue - 10),
    })),
    recent_payments: [],
    recent_activities: [],
    open_deals: [],
  };
}

const RELIABLE: PaymentReliability = { dso_days: 26, payment_terms_days: 30 };
const SLIGHTLY_LATE: PaymentReliability = { dso_days: 40, payment_terms_days: 30 };
const CHRONIC: PaymentReliability = { dso_days: 62, payment_terms_days: 30 };
const NEVER_SETTLED: PaymentReliability = { dso_days: null, payment_terms_days: 30 };

const score = (days: number, rel: PaymentReliability | null, reminders = 0) =>
  assessRisk(context(days, rel), state({ reminders_sent: reminders })).score;

describe("reading the payment record", () => {
  it("calls a customer who settles inside their own terms reliable", () => {
    expect(reliabilityBand(RELIABLE, 30)).toBe("always_pays");
    // Judged against THEIR terms, not a constant: 55 days on 60-day terms is
    // paying on time, and telling that customer otherwise loses their trust.
    expect(reliabilityBand({ dso_days: 55, payment_terms_days: 60 }, 30)).toBe("always_pays");
  });

  it("separates a little late from always late", () => {
    // 15 days of grace, the same tolerance the health module already allows.
    expect(reliabilityBand({ dso_days: 45, payment_terms_days: 30 }, 30)).toBe("pays_late");
    expect(reliabilityBand({ dso_days: 46, payment_terms_days: 30 }, 30)).toBe("chronically_late");
  });

  it("does not brand a new customer as a bad payer", () => {
    // Nothing settled, but only a week late on 30-day terms — they have not yet
    // had the chance. "Unknown" must not read as "bad".
    expect(reliabilityBand(NEVER_SETTLED, 7)).toBe("unproven");
    expect(reliabilityBand(NEVER_SETTLED, 45)).toBe("unproven");
  });

  it("does brand one that has had a full cycle and paid nothing", () => {
    expect(reliabilityBand(NEVER_SETTLED, 46)).toBe("never_paid");
    expect(reliabilityBand(NEVER_SETTLED, 300)).toBe("never_paid");
  });

  it("treats a missing record as unknown, not as bad", () => {
    // The degenerate context: no customer row at all.
    expect(reliabilityBand(null, 200)).toBe("unproven");
    expect(RELIABILITY_FACTORS.unproven).toBe(1);
  });

  it("orders the factors so that paying at all counts for something", () => {
    const f = RELIABILITY_FACTORS;
    expect(f.always_pays).toBeLessThan(f.pays_late);
    expect(f.pays_late).toBeLessThan(f.chronically_late);
    // Chronically late but paying is still better than never having paid, and
    // better than unknown is not claimed — unknown sits between them.
    expect(f.chronically_late).toBeLessThan(f.unproven);
    expect(f.unproven).toBeLessThan(f.never_paid);
  });
});

describe("the lateness curve", () => {
  it("does not saturate — the old formula's actual defect", () => {
    // 20 days used to score 100. Every one of these must now be distinct and
    // increasing, or the score cannot tell a late invoice from a lost one.
    const days = [1, 7, 20, 30, 45, 60, 90, 120, 180, 365];
    const points = days.map(latenessPoints);
    for (let i = 1; i < points.length; i++) {
      expect(points[i], `${days[i]} days`).toBeGreaterThan(points[i - 1]!);
    }
  });

  it("never reaches the ceiling on lateness alone", () => {
    // 100 is reserved for "likely write-off", which needs more than a date.
    expect(latenessPoints(10_000)).toBeLessThanOrEqual(55);
    expect(score(10_000, NEVER_SETTLED)).toBeLessThan(100);
  });

  it("treats 60–90 days as notable rather than alarming", () => {
    // The Malaysian norm. A score in the 30s says "chase them", not "write it off".
    expect(latenessPoints(60)).toBeLessThanOrEqual(35);
    expect(latenessPoints(90)).toBeLessThanOrEqual(45);
  });

  it("handles the edges without going negative or NaN", () => {
    expect(latenessPoints(0)).toBe(0);
    expect(latenessPoints(-5)).toBe(0);
    expect(Number.isFinite(latenessPoints(1e9))).toBe(true);
  });
});

describe("ignored reminders", () => {
  it("counts for more than a few extra days late", () => {
    expect(persistencePoints(0)).toBe(0);
    expect(persistencePoints(1)).toBeGreaterThan(0);
    expect(persistencePoints(3)).toBeGreaterThan(persistencePoints(2));
  });

  it("stops climbing rather than running away", () => {
    expect(persistencePoints(50)).toBe(persistencePoints(3));
  });
});

describe("the weighting the score exists for", () => {
  it("scores a reliable customer well below an unknown one at the same lateness", () => {
    // The whole point: same invoice, same day, different customer.
    const reliable = score(30, RELIABLE);
    const unknown = score(30, NEVER_SETTLED);
    expect(reliable).toBeLessThan(unknown);
    // And meaningfully below, not by a rounding error: the always_pays factor is
    // 0.55, so a reliable customer scores at least 40% lower at the same lateness.
    expect(reliable).toBeLessThanOrEqual(unknown * 0.6);
  });

  it("scores a chronic-but-paying customer below one who has never paid", () => {
    expect(score(90, CHRONIC)).toBeLessThan(score(90, NEVER_SETTLED));
  });

  it("keeps every band in order at a fixed lateness", () => {
    const at = (rel: PaymentReliability | null) => score(75, rel, 1);
    expect(at(RELIABLE)).toBeLessThan(at(SLIGHTLY_LATE));
    expect(at(SLIGHTLY_LATE)).toBeLessThan(at(CHRONIC));
    expect(at(CHRONIC)).toBeLessThan(at(null)); // unproven
    expect(at(null)).toBeLessThan(at(NEVER_SETTLED));
  });

  it("does not let reliability cancel the debt", () => {
    // Being a good payer is a reason to chase politely, not a reason to stop
    // counting. A reliable customer 120 days late is still a real number.
    expect(score(120, RELIABLE)).toBeGreaterThan(20);
  });

  it("still climbs with lateness inside every band", () => {
    for (const rel of [RELIABLE, SLIGHTLY_LATE, CHRONIC, NEVER_SETTLED, null]) {
      expect(score(90, rel)).toBeGreaterThan(score(30, rel));
    }
  });

  it("puts the worst case near the top without ever inventing certainty", () => {
    // Never paid, a year late, every reminder ignored.
    const worst = score(400, NEVER_SETTLED, 5);
    expect(worst).toBeGreaterThan(80);
    expect(worst).toBeLessThanOrEqual(100);
  });
});

describe("the score's floor and ceiling", () => {
  it("reserves 0 for nothing being due", () => {
    const nothing = fallbackDecision(context(0, RELIABLE, 0), state());
    expect(nothing).toMatchObject({ risk_score: 0, action: "wait" });
  });

  it("never reports 0 while an invoice is overdue", () => {
    // A reliable customer one day late rounds to nothing; "will certainly pay"
    // is a stronger claim than the situation supports.
    expect(score(1, RELIABLE)).toBe(1);
  });

  it("clamps to the schema's 0–100 range", () => {
    for (const days of [0, 1, 500, 100_000]) {
      for (const rel of [RELIABLE, NEVER_SETTLED, null]) {
        for (const reminders of [0, 5, 99]) {
          const s = score(days, rel, reminders);
          expect(Number.isInteger(s)).toBe(true);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe("what the score does NOT change", () => {
  it("leaves the fallback's action logic alone", () => {
    // Re-tuning the score must not quietly change who gets escalated: the action
    // is decided separately and then guarded (PRD-002), and the escalation gate
    // is the only thing allowed to move that line.
    const first = fallbackDecision(context(200, NEVER_SETTLED), state());
    expect(first.action).toBe("remind");

    const chased = fallbackDecision(
      context(200, NEVER_SETTLED),
      state({ escalation_stage: "reminded", reminders_sent: 2 }),
    );
    expect(chased.action).toBe("escalate");
  });

  it("keeps naming the invoice, so the reference guard has nothing to correct", () => {
    const decision = fallbackDecision(context(45, CHRONIC), state());
    expect(decision.message).toContain("inv_0");
    expect(decision.message).toContain("MYR 1000.00");
  });

  it("reports its components, so a surprising score can be explained", () => {
    const assessment = assessRisk(context(75, CHRONIC), state({ reminders_sent: 1 }));
    expect(assessment).toMatchObject({ band: "chronically_late", factor: 0.9 });
    expect(assessment.lateness).toBeGreaterThan(0);
    expect(assessment.persistence).toBeGreaterThan(0);
    expect(assessment.score).toBe(
      Math.round((assessment.lateness + assessment.persistence) * assessment.factor),
    );
  });

  it("keys off the oldest invoice when several are open", () => {
    const one = assessRisk(context(90, NEVER_SETTLED, 1), state());
    const many = assessRisk(context(90, NEVER_SETTLED, 4), state());
    // Four invoices, oldest the same age: the score is the same, because the
    // score does not count exposure (see assessRisk — currencies are not
    // convertible here yet). Documented rather than accidental.
    expect(many.score).toBe(one.score);
  });
});
