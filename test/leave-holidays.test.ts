import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { MY_PUBLIC_HOLIDAYS, SHIPPED_YEARS } from "../src/modules/leave/holidays/data";
import { isHolidayScope, STATE_CODES } from "../src/modules/leave/holidays/states";
import { isIsoDate, yearOf } from "../src/modules/leave/dates";
import type { EffectiveHoliday } from "../src/modules/leave/types";

/**
 * PRD-006b — public holidays, work weeks and working-day counting.
 *
 * Covers the three holiday acceptance criteria:
 *
 *  - leave spanning a weekend and a state holiday deducts working days only;
 *  - two employees in two states each get their own holiday set;
 *  - a Sunday-Thursday work week changes the count.
 *
 * Plus the two things that make the shipped-data-file decision safe: a tenant
 * can override what we ship, and a year we have NOT shipped is reported as
 * missing rather than silently counted as having no holidays.
 *
 * The dates used are all from the confirmed 2026 calendar:
 *
 *   Fri 11 Dec 2026 — Birthday of the Sultan of Selangor (SGR only)
 *   Wed 22 Jul 2026 — Sarawak Day (SWK only)
 */

const API_KEY = "test_api_key_leave_holidays";
const TENANT_ID = "biz_leave_holidays";
const WORKSPACE = "leave-holidays-co";
const OTHER_API_KEY = "test_api_key_leave_holidays_other";
const OTHER_TENANT_ID = "biz_leave_holidays_other";
const ORIGIN = "http://localhost:5173";

const bearer = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const otherBearer = { Authorization: `Bearer ${OTHER_API_KEY}`, "Content-Type": "application/json" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface WorkingDays {
  working_days: number;
  calendar_days: number;
  non_working_days: number;
  holidays: { date: string; name: string }[];
  holiday_data_available: boolean;
  holiday_data_provisional: boolean;
  work_state: string | null;
  error?: string;
}

async function workingDays(
  employeeId: string,
  start: string,
  end: string,
  extra = "",
): Promise<WorkingDays> {
  const res = await fetchWorker(
    `/v1/people/leave/working-days?employee_id=${employeeId}&start=${start}&end=${end}${extra}`,
    { headers: bearer },
  );
  return (await res.json()) as WorkingDays;
}

async function createEmployee(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await fetchWorker("/v1/people/employees", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({ name, department_id: "operations", ...extra }),
  });
  return ((await res.json()) as { employee_id: string }).employee_id;
}

async function setProfile(employeeId: string, body: Record<string, unknown>): Promise<Response> {
  return fetchWorker("/v1/people/leave/employee-profiles", {
    method: "PUT",
    headers: bearer,
    body: JSON.stringify({ employee_id: employeeId, ...body }),
  });
}

let selangorEmployee: string;
let sarawakEmployee: string;
let statelessEmployee: string;
let selfEmployee: string;

beforeAll(async () => {
  for (const [tenantId, name, slug, key] of [
    [TENANT_ID, "Leave Holidays Tenant", WORKSPACE, API_KEY],
    [OTHER_TENANT_ID, "Other Tenant", "leave-holidays-other-co", OTHER_API_KEY],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(tenantId, name, slug, await sha256Hex(key))
      .run();
  }

  const staff = await createUser(env.DB, {
    tenant_id: TENANT_ID,
    email: "staff@leaveholidays.test",
    password: "employee-password",
    role: "employee",
  });

  selangorEmployee = await createEmployee("Aisha KL", { location: "Shah Alam" });
  sarawakEmployee = await createEmployee("John Kuching", { location: "Kuching" });
  statelessEmployee = await createEmployee("Remote Rahim");
  selfEmployee = await createEmployee("Self Service Siti", { user_id: staff.user_id });

  await setProfile(selangorEmployee, { work_state: "SGR" });
  await setProfile(sarawakEmployee, { work_state: "SWK" });
  await setProfile(selfEmployee, { work_state: "PNG" });
});

describe("the shipped holiday calendar", () => {
  it("is structurally sound for every year it ships", () => {
    for (const year of MY_PUBLIC_HOLIDAYS) {
      expect(year.holidays.length).toBeGreaterThan(10);
      const seen = new Set<string>();
      for (const holiday of year.holidays) {
        expect(isIsoDate(holiday.date)).toBe(true);
        // A date filed under the wrong year would silently disappear from
        // every query, which is the kind of gap nobody notices until April.
        expect(yearOf(holiday.date)).toBe(year.year);
        expect(holiday.name.length).toBeGreaterThan(0);

        if (holiday.scopes === "national") {
          expect(isHolidayScope("national")).toBe(true);
        } else {
          expect(holiday.scopes.length).toBeGreaterThan(0);
          for (const scope of holiday.scopes) expect(STATE_CODES).toContain(scope);
        }

        // Two identical entries would double-count nothing but signal a
        // copy-paste error in the year's data.
        const key = `${holiday.date}|${holiday.name}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it("marks future years provisional and confirmed years not", () => {
    const byYear = new Map(MY_PUBLIC_HOLIDAYS.map((y) => [y.year, y]));
    expect(byYear.get(2026)!.provisional).toBe(false);
    expect(byYear.get(2027)!.provisional).toBe(true);
    expect(byYear.get(2027)!.source_note).toContain("PROVISIONAL");
  });

  it("carries the five compulsory national holidays every year", () => {
    for (const year of MY_PUBLIC_HOLIDAYS) {
      const national = year.holidays.filter((h) => h.scopes === "national").map((h) => h.name);
      for (const name of [
        "National Day",
        "Malaysia Day",
        "Labour Day",
        "Birthday of the Yang di-Pertuan Agong",
      ]) {
        expect(national, `${year.year} is missing ${name}`).toContain(name);
      }
    }
  });

  it("scopes the holidays that genuinely vary by state", () => {
    const y2026 = MY_PUBLIC_HOLIDAYS.find((y) => y.year === 2026)!;
    const deepavali = y2026.holidays.find((h) => h.name === "Deepavali")!;
    // Sarawak does not observe Deepavali — the kind of detail an office
    // manager notices on day one.
    expect(deepavali.scopes).not.toBe("national");
    expect(deepavali.scopes as readonly string[]).not.toContain("SWK");
    expect(deepavali.scopes as readonly string[]).toContain("SGR");

    const sarawakDay = y2026.holidays.find((h) => h.name === "Sarawak Day")!;
    expect(sarawakDay.scopes).toEqual(["SWK"]);
  });
});

describe("working-day counting", () => {
  /**
   * PRD-006 acceptance criterion: "Given leave spanning a weekend and a state
   * holiday, then only working days are deducted."
   */
  it("deducts only working days across a weekend and a state holiday", async () => {
    // Wed 9 Dec 2026 → Mon 14 Dec 2026, for a Selangor employee.
    // Fri 11 Dec is the Sultan of Selangor's birthday; Sat 12 and Sun 13 are
    // the weekend. Wed, Thu and Mon are worked.
    const result = await workingDays(selangorEmployee, "2026-12-09", "2026-12-14");
    expect(result.calendar_days).toBe(6);
    expect(result.working_days).toBe(3);
    expect(result.non_working_days).toBe(3);
    expect(result.holidays).toEqual([
      { date: "2026-12-11", name: "Birthday of the Sultan of Selangor" },
    ]);
    expect(result.holiday_data_available).toBe(true);
    expect(result.holiday_data_provisional).toBe(false);
  });

  /**
   * PRD-006 acceptance criterion: "Given employees in two states, then each has
   * their own holiday set applied."
   */
  it("applies each employee's own state holiday set", async () => {
    // Same dates, two states, two answers — the Selangor holiday on 11 Dec is
    // an ordinary working day in Sarawak.
    const selangor = await workingDays(selangorEmployee, "2026-12-09", "2026-12-14");
    const sarawak = await workingDays(sarawakEmployee, "2026-12-09", "2026-12-14");
    expect(selangor.working_days).toBe(3);
    expect(sarawak.working_days).toBe(4);
    expect(sarawak.holidays).toEqual([]);

    // And the other way round: Sarawak Day, Wed 22 Jul 2026.
    const swkJuly = await workingDays(sarawakEmployee, "2026-07-20", "2026-07-24");
    const sgrJuly = await workingDays(selangorEmployee, "2026-07-20", "2026-07-24");
    expect(swkJuly.working_days).toBe(4);
    expect(swkJuly.holidays).toEqual([{ date: "2026-07-22", name: "Sarawak Day" }]);
    expect(sgrJuly.working_days).toBe(5);
  });

  it("gives an employee with no work state the national set only", async () => {
    // 11 Dec is a Selangor holiday, so it does not apply; the week is otherwise
    // ordinary. Under-applying is the safe direction — one holiday fewer, never
    // one they were not entitled to.
    const result = await workingDays(statelessEmployee, "2026-12-09", "2026-12-14");
    expect(result.work_state).toBeNull();
    expect(result.working_days).toBe(4);

    // Christmas Day is national, so everyone gets it. Fri 25 Dec 2026.
    const christmas = await workingDays(statelessEmployee, "2026-12-21", "2026-12-25");
    expect(christmas.holidays).toEqual([{ date: "2026-12-25", name: "Christmas Day" }]);
    expect(christmas.working_days).toBe(4);
  });

  it("does not credit a holiday that falls on a non-working day", async () => {
    // Sun 8 Nov 2026 is Deepavali. A Mon-Fri employee was not working anyway,
    // so it must not appear as a day the holiday saved them.
    const result = await workingDays(selangorEmployee, "2026-11-06", "2026-11-09");
    expect(result.calendar_days).toBe(4);
    expect(result.working_days).toBe(2); // Fri 6 and Mon 9
    expect(result.holidays).toEqual([]);
  });

  it("halves the boundary days when a half day is requested", async () => {
    // Mon 7 Dec → Wed 9 Dec 2026: three working days.
    expect((await workingDays(selangorEmployee, "2026-12-07", "2026-12-09")).working_days).toBe(3);
    expect(
      (await workingDays(selangorEmployee, "2026-12-07", "2026-12-09", "&start_half_day=true"))
        .working_days,
    ).toBe(2.5);
    expect(
      (
        await workingDays(
          selangorEmployee,
          "2026-12-07",
          "2026-12-09",
          "&start_half_day=true&end_half_day=true",
        )
      ).working_days,
    ).toBe(2);
    // A single day flagged on both ends is half a day, not a quarter.
    expect(
      (
        await workingDays(
          selangorEmployee,
          "2026-12-07",
          "2026-12-07",
          "&start_half_day=true&end_half_day=true",
        )
      ).working_days,
    ).toBe(0.5);
  });

  it("reads start_half_day=false as false", async () => {
    const result = await workingDays(
      selangorEmployee,
      "2026-12-07",
      "2026-12-09",
      "&start_half_day=false",
    );
    expect(result.working_days).toBe(3);
  });

  it("rejects an end date before the start date", async () => {
    const res = await fetchWorker(
      `/v1/people/leave/working-days?employee_id=${selangorEmployee}&start=2026-12-09&end=2026-12-01`,
      { headers: bearer },
    );
    expect(res.status).toBe(400);
  });
});

describe("configurable work week", () => {
  /**
   * PRD-006 acceptance criterion: "Given a tenant with a Sun-Thu work week,
   * then day counting reflects it."
   */
  it("counts a Sunday-Thursday tenant work week", async () => {
    // Mon 20 Jul → Fri 24 Jul 2026. On Mon-Fri that is 5 working days.
    expect((await workingDays(selangorEmployee, "2026-07-20", "2026-07-24")).working_days).toBe(5);

    await fetchWorker("/v1/people/leave/settings", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ work_week: [1, 1, 1, 1, 1, 0, 0] }), // Sun-Thu
    });

    // Friday is no longer a working day, so the same span costs 4.
    const after = await workingDays(selangorEmployee, "2026-07-20", "2026-07-24");
    expect(after.working_days).toBe(4);

    // And a Sunday now counts: Sun 19 Jul through Thu 23 Jul is 5 days.
    expect((await workingDays(selangorEmployee, "2026-07-19", "2026-07-23")).working_days).toBe(5);
  });

  it("counts a Saturday half-day", async () => {
    await fetchWorker("/v1/people/leave/settings", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ work_week: [0, 1, 1, 1, 1, 1, 0.5] }),
    });
    // Mon 7 Dec → Sat 12 Dec 2026, Selangor: Mon-Thu = 4, Fri is the Sultan's
    // birthday, Sat is half. 4.5 in total.
    const result = await workingDays(selangorEmployee, "2026-12-07", "2026-12-12");
    expect(result.working_days).toBe(4.5);
  });

  it("lets one employee override the tenant work week", async () => {
    // The real case: a KL head office on Mon-Fri with a Kota Bharu branch on
    // Sun-Thu, inside one tenant.
    const kelantan = await createEmployee("Kelantan Kamal");
    await setProfile(kelantan, { work_state: "KTN", work_week: [1, 1, 1, 1, 1, 0, 0] });

    // Tenant default is untouched (Mon-Fri) — the KL employee still works Friday.
    expect((await workingDays(selangorEmployee, "2026-07-20", "2026-07-24")).working_days).toBe(5);
    expect((await workingDays(kelantan, "2026-07-20", "2026-07-24")).working_days).toBe(4);
  });

  it("rejects an unknown work state", async () => {
    const employee = await createEmployee("Wrong State Wan");
    const res = await setProfile(employee, { work_state: "XXX" });
    expect(res.status).toBe(400);
  });
});

describe("tenant overrides of the shipped calendar", () => {
  it("adds a company holiday that the shipped calendar does not have", async () => {
    const before = await workingDays(selangorEmployee, "2026-07-20", "2026-07-24");
    expect(before.working_days).toBe(5);

    const res = await fetchWorker("/v1/people/leave/holidays", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        holiday_date: "2026-07-23",
        name: "Company Anniversary",
        scope: "national",
      }),
    });
    expect(res.status).toBe(201);

    const after = await workingDays(selangorEmployee, "2026-07-20", "2026-07-24");
    expect(after.working_days).toBe(4);
    expect(after.holidays).toEqual([{ date: "2026-07-23", name: "Company Anniversary" }]);
  });

  it("suppresses a shipped holiday the tenant trades through", async () => {
    expect((await workingDays(selangorEmployee, "2026-12-09", "2026-12-14")).working_days).toBe(3);

    await fetchWorker("/v1/people/leave/holidays", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        holiday_date: "2026-12-11",
        name: "Birthday of the Sultan of Selangor",
        scope: "SGR",
        observed: false,
        note: "Trading as normal; replacement day taken in January",
      }),
    });

    const after = await workingDays(selangorEmployee, "2026-12-09", "2026-12-14");
    expect(after.working_days).toBe(4);
    expect(after.holidays).toEqual([]);
  });

  it("renames a shipped holiday without removing it", async () => {
    await fetchWorker("/v1/people/leave/holidays", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        holiday_date: "2026-12-11",
        name: "Selangor Sultan's Birthday (company name)",
        scope: "SGR",
      }),
    });
    const result = await workingDays(selangorEmployee, "2026-12-09", "2026-12-14");
    expect(result.working_days).toBe(3);
    expect(result.holidays[0]!.name).toBe("Selangor Sultan's Birthday (company name)");
  });

  it("suppressing a state holiday leaves other states alone", async () => {
    await fetchWorker("/v1/people/leave/holidays", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        holiday_date: "2026-07-22",
        name: "Sarawak Day",
        scope: "SWK",
        observed: false,
      }),
    });
    // Sarawak loses it...
    expect((await workingDays(sarawakEmployee, "2026-07-20", "2026-07-24")).working_days).toBe(5);
    // ...and Selangor, who never had it, is unaffected.
    expect((await workingDays(selangorEmployee, "2026-07-20", "2026-07-24")).working_days).toBe(5);
  });

  it("removing an override restores the shipped calendar", async () => {
    const created = await fetchWorker("/v1/people/leave/holidays", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        holiday_date: "2026-12-11",
        name: "Suppressed",
        scope: "SGR",
        observed: false,
      }),
    });
    const { holiday } = (await created.json()) as { holiday: { holiday_id: string } };
    expect((await workingDays(selangorEmployee, "2026-12-09", "2026-12-14")).working_days).toBe(4);

    const del = await fetchWorker(`/v1/people/leave/holidays/${holiday.holiday_id}`, {
      method: "DELETE",
      headers: bearer,
    });
    expect(del.status).toBe(200);
    expect((await workingDays(selangorEmployee, "2026-12-09", "2026-12-14")).working_days).toBe(3);
  });

  it("keeps one tenant's overrides out of another tenant's calendar", async () => {
    await fetchWorker("/v1/people/leave/holidays", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        holiday_date: "2026-07-23",
        name: "Company Anniversary",
        scope: "national",
      }),
    });

    const mine = await fetchWorker("/v1/people/leave/holidays?year=2026", { headers: bearer });
    const theirs = await fetchWorker("/v1/people/leave/holidays?year=2026", { headers: otherBearer });
    const mineNames = ((await mine.json()) as { holidays: EffectiveHoliday[] }).holidays.map((h) => h.name);
    const theirNames = ((await theirs.json()) as { holidays: EffectiveHoliday[] }).holidays.map((h) => h.name);

    expect(mineNames).toContain("Company Anniversary");
    expect(theirNames).not.toContain("Company Anniversary");
    // Both still see the shipped calendar — it is not per-tenant data.
    expect(theirNames).toContain("National Day");
  });

  it("rejects an unknown holiday scope", async () => {
    const res = await fetchWorker("/v1/people/leave/holidays", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ holiday_date: "2026-07-23", name: "Nope", scope: "ZZZ" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("years the calendar does not cover", () => {
  it("says so rather than reporting a year with no holidays", async () => {
    const res = await fetchWorker("/v1/people/leave/holidays?year=2035", { headers: bearer });
    const body = (await res.json()) as {
      holidays: EffectiveHoliday[];
      holiday_data_available: boolean;
    };
    expect(body.holidays).toEqual([]);
    // The load-bearing assertion: an empty list must not be indistinguishable
    // from "we have no data", or every day of 2035 silently becomes workable.
    expect(body.holiday_data_available).toBe(false);
  });

  it("still counts working days for an unshipped year, but flags the gap", async () => {
    const result = await workingDays(selangorEmployee, "2035-07-02", "2035-07-06");
    expect(result.working_days).toBe(5);
    expect(result.holiday_data_available).toBe(false);
  });

  it("flags a provisional year", async () => {
    const res = await fetchWorker("/v1/people/leave/holidays?year=2027&state=SGR", {
      headers: bearer,
    });
    const body = (await res.json()) as {
      holiday_data_provisional: boolean;
      source_note: string;
    };
    expect(body.holiday_data_provisional).toBe(true);
    expect(body.source_note).toContain("moon sighting");
  });

  it("publishes the state list and the years it ships", async () => {
    const res = await fetchWorker("/v1/people/leave/states", { headers: bearer });
    const body = (await res.json()) as {
      states: { code: string; name: string }[];
      shipped_holiday_years: number[];
    };
    expect(body.states).toHaveLength(16);
    expect(body.states.map((s) => s.code)).toContain("SWK");
    expect(body.shipped_holiday_years).toEqual([...SHIPPED_YEARS]);
  });
});

describe("employee self-service holidays", () => {
  async function selfSession(): Promise<Record<string, string>> {
    const res = await fetchWorker("/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        workspace: WORKSPACE,
        email: "staff@leaveholidays.test",
        password: "employee-password",
      }),
    });
    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const { csrf_token } = (await res.json()) as { csrf_token: string };
    return { Cookie: cookie, "X-CSRF-Token": csrf_token, Origin: ORIGIN };
  }

  it("shows an employee their own state's holidays without any business access", async () => {
    const headers = await selfSession();
    // The same login is refused the HR surface...
    expect((await fetchWorker("/v1/people/leave/holidays?year=2026", { headers })).status).toBe(403);

    // ...but sees its own, resolved from the session, with no id to tamper with.
    const res = await fetchWorker("/v1/me/leave/holidays?year=2026", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { work_state: string; holidays: EffectiveHoliday[] };
    expect(body.work_state).toBe("PNG");
    // Penang observes Thaipusam; Sarawak does not.
    expect(body.holidays.map((h) => h.name)).toContain("Thaipusam");
    expect(body.holidays.map((h) => h.name)).not.toContain("Sarawak Day");
  });

  it("prices a date range for the employee themselves", async () => {
    const headers = await selfSession();
    const res = await fetchWorker(
      "/v1/me/leave/working-days?start=2026-12-07&end=2026-12-11",
      { headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkingDays;
    // Penang has no holiday that week, so a full Mon-Fri.
    expect(body.working_days).toBe(5);
  });

  it("400s a self-service call made with a tenant API key", async () => {
    const res = await fetchWorker("/v1/me/leave/balances", { headers: bearer });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "not_a_user" });
  });
});
