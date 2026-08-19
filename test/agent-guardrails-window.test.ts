import { describe, it, expect } from "vitest";
import {
  contactWindow,
  DEFAULT_AGENT_POLICY,
  DEFAULT_TIME_ZONE,
  loadAgentPolicy,
  parseWorkWeek,
  referencedIds,
  resolveTimeZone,
  wallToEpoch,
  zoneOffsetMs,
  zoneParts,
  type AgentPolicy,
  type HolidayLookup,
} from "../src/agents/guardrails";

/**
 * The guardrail primitives, on fixed timestamps.
 *
 * PRD-002 calls a WhatsApp at 2am "a product-defining mistake", and the only
 * thing standing between the agent and that mistake is this arithmetic. So it
 * is tested directly, with instants written out in UTC and expectations written
 * out in tenant-local time — no `Date.now()` anywhere, so nothing here depends
 * on when CI runs.
 *
 * Malaysia is UTC+8 with no DST, so `Asia/Kuala_Lumpur` cases are exact; the
 * DST-bearing zones are here to prove the arithmetic is not secretly a fixed
 * offset.
 */

const at = (iso: string) => Date.parse(iso);
const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  ...DEFAULT_AGENT_POLICY,
  ...over,
});
const holidaysOn = (...dates: string[]): HolidayLookup => ({
  isHoliday: (date) => dates.includes(date),
});

describe("tenant local time", () => {
  it("reads wall-clock parts in the tenant's zone", () => {
    // 15:00 UTC is 23:00 in Kuala Lumpur, the same day.
    const p = zoneParts("Asia/Kuala_Lumpur", at("2026-08-19T15:00:00Z"));
    expect(p).toMatchObject({ year: 2026, month: 8, day: 19, hour: 23, date: "2026-08-19" });
    // 2026-08-19 is a Wednesday.
    expect(p.weekday).toBe(3);
  });

  it("crosses midnight into the next local day", () => {
    // 17:00 UTC is 01:00 the FOLLOWING day in Kuala Lumpur — the case that
    // makes "today" ambiguous and holiday lookups wrong if done in UTC.
    const p = zoneParts("Asia/Kuala_Lumpur", at("2026-08-19T17:00:00Z"));
    expect(p).toMatchObject({ day: 20, hour: 1, date: "2026-08-20" });
  });

  it("reports the offset, including zones that are not whole hours", () => {
    expect(zoneOffsetMs("Asia/Kuala_Lumpur", at("2026-08-19T00:00:00Z"))).toBe(8 * 3_600_000);
    expect(zoneOffsetMs("Asia/Kathmandu", at("2026-08-19T00:00:00Z"))).toBe(5 * 3_600_000 + 45 * 60_000);
    expect(zoneOffsetMs("UTC", at("2026-08-19T00:00:00Z"))).toBe(0);
  });

  it("follows daylight saving rather than assuming a fixed offset", () => {
    // Southern hemisphere: +13 in January, +12 in July.
    expect(zoneOffsetMs("Pacific/Auckland", at("2026-01-15T00:00:00Z"))).toBe(13 * 3_600_000);
    expect(zoneOffsetMs("Pacific/Auckland", at("2026-07-15T00:00:00Z"))).toBe(12 * 3_600_000);
    // Northern: 0 in January, +1 in July.
    expect(zoneOffsetMs("Europe/London", at("2026-01-15T00:00:00Z"))).toBe(0);
    expect(zoneOffsetMs("Europe/London", at("2026-07-15T00:00:00Z"))).toBe(3_600_000);
  });

  it("round-trips wall time → epoch → wall time on both sides of a DST change", () => {
    for (const date of ["2026-01-15", "2026-07-15"]) {
      for (const zone of ["Pacific/Auckland", "Europe/London", "Asia/Kuala_Lumpur"]) {
        const epoch = wallToEpoch(zone, { date, hour: 9 });
        expect(zoneParts(zone, epoch)).toMatchObject({ date, hour: 9, minute: 0 });
      }
    }
  });

  it("falls back to Malaysia for a zone name it cannot use", () => {
    expect(resolveTimeZone("Asia/Kuala_Lumpur")).toBe("Asia/Kuala_Lumpur");
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone(null)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone("")).toBe(DEFAULT_TIME_ZONE);
  });
});

describe("the contact window", () => {
  it("is open inside business hours on a working day", () => {
    // 12:00 Wednesday in Kuala Lumpur.
    const now = at("2026-08-19T04:00:00Z");
    expect(contactWindow(policy(), now)).toMatchObject({ open: true, next_open_at: now, reason: "open" });
  });

  it("defers a 23:00 decision to 09:00, and does not drop it", () => {
    // PRD-002's own acceptance criterion, in tenant-local terms: 23:00
    // Wednesday in Kuala Lumpur → 09:00 Thursday, which is 01:00Z.
    const result = contactWindow(policy(), at("2026-08-19T15:00:00Z"));
    expect(result.open).toBe(false);
    expect(result.reason).toBe("outside_hours");
    expect(new Date(result.next_open_at).toISOString()).toBe("2026-08-20T01:00:00.000Z");
    expect(zoneParts("Asia/Kuala_Lumpur", result.next_open_at)).toMatchObject({
      date: "2026-08-20",
      hour: 9,
    });
  });

  it("opens later the same day when the window has not started yet", () => {
    // 08:00 Wednesday → 09:00 Wednesday, not tomorrow.
    const result = contactWindow(policy(), at("2026-08-19T00:00:00Z"));
    expect(result.open).toBe(false);
    expect(new Date(result.next_open_at).toISOString()).toBe("2026-08-19T01:00:00.000Z");
  });

  it("treats the closing hour as closed", () => {
    // 18:00 exactly, with an 09:00–18:00 window: shut. Half-open [start, end)
    // is the only reading where "no contact after 18:00" means what it says.
    const result = contactWindow(policy(), at("2026-08-19T10:00:00Z"));
    expect(result.open).toBe(false);
    expect(new Date(result.next_open_at).toISOString()).toBe("2026-08-20T01:00:00.000Z");
    // One minute earlier is still fine.
    expect(contactWindow(policy(), at("2026-08-19T09:59:00Z")).open).toBe(true);
  });

  it("skips the weekend, using the work week the tenant already configured", () => {
    // Saturday noon → Monday 09:00.
    const saturday = contactWindow(policy(), at("2026-08-22T04:00:00Z"));
    expect(saturday).toMatchObject({ open: false, reason: "non_working_day" });
    expect(new Date(saturday.next_open_at).toISOString()).toBe("2026-08-24T01:00:00.000Z");

    // Friday evening → Monday 09:00 as well.
    const friday = contactWindow(policy(), at("2026-08-21T14:00:00Z"));
    expect(new Date(friday.next_open_at).toISOString()).toBe("2026-08-24T01:00:00.000Z");
  });

  it("honours a six-day work week", () => {
    // A tenant whose leave_settings say Saturday is a working day.
    const sixDay = policy({ work_week: [0, 1, 1, 1, 1, 1, 0.5] });
    expect(contactWindow(sixDay, at("2026-08-22T04:00:00Z")).open).toBe(true);
  });

  it("contacts on a weekend when the tenant turns the suppression off", () => {
    expect(contactWindow(policy({ suppress_weekends: false }), at("2026-08-22T04:00:00Z")).open).toBe(
      true,
    );
  });

  it("skips public holidays, and keeps skipping through a run of them", () => {
    // Thursday and Friday both holidays → Monday.
    const result = contactWindow(
      policy(),
      at("2026-08-19T15:00:00Z"),
      holidaysOn("2026-08-20", "2026-08-21"),
    );
    expect(result.reason).toBe("outside_hours"); // today's reason: it is 23:00
    expect(new Date(result.next_open_at).toISOString()).toBe("2026-08-24T01:00:00.000Z");
  });

  it("names the holiday as the reason when today is the holiday", () => {
    const result = contactWindow(policy(), at("2026-08-19T04:00:00Z"), holidaysOn("2026-08-19"));
    expect(result).toMatchObject({ open: false, reason: "public_holiday" });
    expect(new Date(result.next_open_at).toISOString()).toBe("2026-08-20T01:00:00.000Z");
  });

  it("ignores holidays for a tenant that trades through them", () => {
    const trading = policy({ suppress_holidays: false });
    expect(contactWindow(trading, at("2026-08-19T04:00:00Z"), holidaysOn("2026-08-19")).open).toBe(
      true,
    );
  });

  it("still opens eventually when the work week says no day is a working day", () => {
    // A misconfiguration that must not become a permanent stop: honour the
    // hours, give up on the days. PRD-002's non-negotiable is that collections
    // never silently stops.
    const closed = policy({ work_week: [0, 0, 0, 0, 0, 0, 0] });
    const result = contactWindow(closed, at("2026-08-19T04:00:00Z"));
    expect(result.open).toBe(false);
    expect(result.next_open_at).toBeGreaterThan(at("2026-08-19T04:00:00Z"));
    expect(zoneParts("Asia/Kuala_Lumpur", result.next_open_at).hour).toBe(9);
  });

  it("works in a zone that is not a whole number of hours off UTC", () => {
    const nepal = policy({ timezone: "Asia/Kathmandu" });
    // 03:15Z is exactly 09:00 in Kathmandu (+5:45).
    expect(contactWindow(nepal, at("2026-08-19T03:15:00Z")).open).toBe(true);
    expect(contactWindow(nepal, at("2026-08-19T03:14:00Z")).open).toBe(false);
  });

  it("uses a 24-hour window when a tenant asks for one", () => {
    const always = policy({
      contact_window_start_hour: 0,
      contact_window_end_hour: 24,
      suppress_weekends: false,
      suppress_holidays: false,
    });
    expect(contactWindow(always, at("2026-08-19T16:00:00Z")).open).toBe(true); // midnight KL
    expect(contactWindow(always, at("2026-08-22T20:00:00Z")).open).toBe(true); // Sunday 04:00 KL
  });
});

describe("the work week, as stored by the people module", () => {
  it("parses leave_settings.work_week", () => {
    expect(parseWorkWeek("[0,1,1,1,1,1,0]")).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(parseWorkWeek("[0,1,1,1,1,1,0.5]")).toEqual([0, 1, 1, 1, 1, 1, 0.5]);
  });

  it("falls back to Mon–Fri rather than trusting a malformed value", () => {
    expect(parseWorkWeek(null)).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(parseWorkWeek("not json")).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(parseWorkWeek("[1,1,1]")).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(parseWorkWeek('["mon","tue"]')).toEqual([0, 1, 1, 1, 1, 1, 0]);
  });
});

describe("invoice references in a message", () => {
  it("finds real and invented references alike", () => {
    expect(referencedIds("Invoice inv_01J2X is overdue")).toEqual(["inv_01J2X"]);
    expect(referencedIds("Your invoice INV-9999 is overdue")).toEqual(["INV-9999"]);
    expect(referencedIds("inv_A and INV-B and inv-c")).toEqual(["inv_A", "INV-B", "inv-c"]);
    // The whole reference, separators and all: stopping at the second separator
    // would read this as a citation of `inv_acme` and reject a real invoice.
    expect(referencedIds("invoice inv_acme_7 is due")).toEqual(["inv_acme_7"]);
    expect(referencedIds("inv_01J2X3Y4Z5, thanks.")).toEqual(["inv_01J2X3Y4Z5"]);
  });

  it("finds nothing in a message that names no invoice", () => {
    expect(referencedIds("Your outstanding balance is overdue")).toEqual([]);
    // "invoice" alone is a word, not a reference.
    expect(referencedIds("Please pay the invoice")).toEqual([]);
  });
});

describe("the fallback guarantee, at the policy layer", () => {
  it("uses the conservative defaults when the policy cannot be read at all", async () => {
    // A guard that threw here would stop collections; PRD-002 forbids that. The
    // defaults are safe on every axis, so failing this way is both alive and
    // bounded.
    const broken = {
      prepare() {
        throw new Error("D1_ERROR: no such table: agent_settings");
      },
    } as unknown as D1Database;
    await expect(loadAgentPolicy(broken, "biz_missing")).resolves.toEqual(DEFAULT_AGENT_POLICY);
  });

  it("ships the decided defaults: 09:00–18:00 Malaysia, 60-day escalation, cap 5", () => {
    expect(DEFAULT_AGENT_POLICY).toMatchObject({
      enabled: true,
      timezone: "Asia/Kuala_Lumpur",
      contact_window_start_hour: 9,
      contact_window_end_hour: 18,
      suppress_weekends: true,
      suppress_holidays: true,
      max_reminders_per_invoice: 5,
      // The blocking product decision: Malaysian SME payment norms run 60–90
      // days, so 30 would escalate a customer behaving normally for the market.
      escalation_threshold_days: 60,
      contact_cooldown_hours: 24,
      max_message_chars: 2000,
    });
  });
});
