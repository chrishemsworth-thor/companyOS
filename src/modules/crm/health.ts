import type { CustomerSignals } from "./signals";

/**
 * PRD-003 P0 — customer health.
 *
 * Derived, never stored: computed on read from `getCustomerSignals`, which is
 * the single extra query the acceptance criterion allows. There is no
 * `customer_health` column and no snapshot table (PRD-003 puts health trend in
 * P1, and a trend is the only thing that needs history).
 *
 * ## Reasons matter more than the score
 *
 * PRD-003 is explicit: *"'2 invoices 60+ days overdue, 1 ticket open 14 days'
 * is actionable; a number is not."* So there is no score — only a band and the
 * reasons that produced it. Every reason carries a machine-readable `code` and
 * a human `detail`, and every band is the maximum severity of its reasons, so a
 * band can never disagree with the list under it.
 *
 * ## Signal only — health does NOT pause anything
 *
 * PRD-003's blocking open question was whether `at_risk` should automatically
 * pause outbound sales activity. **Decided for v1: signal only** (Chris/Josh,
 * 2026-08-02; SESSION-PLAN "Blocking decisions"). Nothing in the send path
 * consults this module, and nothing should start to without re-opening that
 * decision, for two reasons:
 *
 *   1. The thresholds below are uncalibrated against real Malaysian SME
 *      payment behaviour. A mis-tuned band that silences collections costs a
 *      tenant money silently — the worst kind of bug to ship.
 *   2. PRD-002 (S10) puts the kill switch in the guardrail layer, enforced in
 *      code after the LLM returns: `agents.enabled` per tenant and a
 *      per-customer `agent_paused`. A second, derived pause here would mean two
 *      places can stop a send and neither is authoritative.
 *
 * The band is machine-readable so S10 can consume it as a guardrail *input*
 * without S8 having pre-empted that design.
 */

export type HealthBand = "good" | "watch" | "at_risk";

export type HealthReasonCode =
  | "insufficient_history"
  | "invoices_severely_overdue"
  | "multiple_overdue_invoices"
  | "invoice_overdue"
  | "slow_payer"
  | "ticket_ageing"
  | "open_tickets"
  | "no_recent_activity"
  | "paying_on_time"
  | "no_open_issues";

export interface HealthReason {
  code: HealthReasonCode;
  /** Human-readable and specific — this is the part an operator acts on. */
  detail: string;
  /** The band this single reason argues for. The band is the max of these. */
  band: HealthBand;
  /** Invoice ids behind the reason, so the console can link them. */
  invoice_ids?: string[];
}

export interface CustomerHealth {
  band: HealthBand;
  reasons: HealthReason[];
}

/** Thresholds, named so the tuning conversation has something to point at. */
const SEVERELY_OVERDUE_DAYS = 60;
const TICKET_AGEING_DAYS = 14;
const STALE_ACTIVITY_DAYS = 90;
/** How far past the customer's OWN terms average payment must drift to matter. */
const DSO_TOLERANCE_DAYS = 15;

const BAND_SEVERITY: Record<HealthBand, number> = { good: 0, watch: 1, at_risk: 2 };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function computeHealth(signals: CustomerSignals): CustomerHealth {
  // A brand-new customer must not read as healthy-by-measurement. PRD-003:
  // "good with an explicit 'insufficient history' reason rather than a
  // misleading score."
  if (!signals.has_history) {
    return {
      band: "good",
      reasons: [
        {
          code: "insufficient_history",
          detail: "No invoices, tickets or activity yet — nothing to assess.",
          band: "good",
        },
      ],
    };
  }

  const reasons: HealthReason[] = [];

  // --- Payment behaviour ---------------------------------------------------
  if (signals.overdue_count > 0) {
    const ids = signals.overdue_invoice_ids;
    if (signals.max_days_overdue >= SEVERELY_OVERDUE_DAYS) {
      reasons.push({
        code: "invoices_severely_overdue",
        detail: `${plural(signals.overdue_count, "invoice")} overdue, the oldest by ${signals.max_days_overdue} days (${ids.join(", ")}).`,
        band: "at_risk",
        invoice_ids: ids,
      });
    } else if (signals.overdue_count >= 2) {
      reasons.push({
        code: "multiple_overdue_invoices",
        detail: `${plural(signals.overdue_count, "invoice")} overdue, the oldest by ${signals.max_days_overdue} days (${ids.join(", ")}).`,
        band: "at_risk",
        invoice_ids: ids,
      });
    } else {
      reasons.push({
        code: "invoice_overdue",
        detail: `1 invoice overdue by ${signals.max_days_overdue} days (${ids.join(", ")}).`,
        band: "watch",
        invoice_ids: ids,
      });
    }
  }

  // Measured against the customer's OWN terms, not a constant: a customer on
  // 60-day terms paying in 55 days is paying on time, and telling their account
  // manager otherwise is how a health signal loses credibility.
  if (
    signals.dso_days !== null &&
    signals.dso_days > signals.payment_terms_days + DSO_TOLERANCE_DAYS
  ) {
    reasons.push({
      code: "slow_payer",
      detail: `Pays in ${Math.round(signals.dso_days)} days on average against ${signals.payment_terms_days}-day terms.`,
      band: "watch",
    });
  }

  // --- Support load --------------------------------------------------------
  if (signals.open_ticket_count > 0) {
    if (signals.oldest_open_ticket_days >= TICKET_AGEING_DAYS) {
      reasons.push({
        code: "ticket_ageing",
        detail: `${plural(signals.open_ticket_count, "open ticket")}, the oldest ${signals.oldest_open_ticket_days} days old.`,
        band: "at_risk",
      });
    } else {
      reasons.push({
        code: "open_tickets",
        detail: `${plural(signals.open_ticket_count, "open ticket")}, the oldest ${signals.oldest_open_ticket_days} days old.`,
        band: "watch",
      });
    }
  }

  // --- Relationship --------------------------------------------------------
  if (signals.days_since_activity !== null && signals.days_since_activity >= STALE_ACTIVITY_DAYS) {
    reasons.push({
      code: "no_recent_activity",
      detail:
        signals.open_deal_cents > 0
          ? `No contact for ${signals.days_since_activity} days, with an open pipeline.`
          : `No contact for ${signals.days_since_activity} days.`,
      band: "watch",
    });
  }

  // A healthy customer gets reasons too — "why do you think this is fine" is a
  // fair question, and an empty panel reads as "not computed".
  if (reasons.length === 0) {
    reasons.push({
      code: signals.dso_days !== null ? "paying_on_time" : "no_open_issues",
      detail:
        signals.dso_days !== null
          ? `Pays in ${Math.round(signals.dso_days)} days against ${signals.payment_terms_days}-day terms, nothing overdue, no open tickets.`
          : "Nothing overdue and no open tickets.",
      band: "good",
    });
  }

  const band = reasons.reduce<HealthBand>(
    (worst, r) => (BAND_SEVERITY[r.band] > BAND_SEVERITY[worst] ? r.band : worst),
    "good",
  );

  // Most severe first — the panel is read top-down and the top line should be
  // the one worth acting on.
  reasons.sort((a, b) => BAND_SEVERITY[b.band] - BAND_SEVERITY[a.band]);

  return { band, reasons };
}
