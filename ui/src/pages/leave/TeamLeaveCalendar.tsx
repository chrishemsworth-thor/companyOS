import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import type { LeaveCalendarResponse, LeaveRequest } from "../../api/types";

/**
 * `/leave/calendar` — who is off, by month (PRD-006c).
 *
 * PRD-006 calls this "the feature managers actually use", and the manager's
 * question is narrow: *will anyone be left covering these dates.* So it is a grid
 * of person × day for one month, not a general-purpose calendar — a month is the
 * unit a rota is planned in, and one row per person is what makes a gap visible at
 * a glance.
 *
 * Scope comes from the server, not from this page: a login with no `people:read`
 * sees its own team, and a `people:read` holder sees the company. So there is no
 * team picker here for someone who could not use it, and no way for this page to
 * ask for more than its role allows.
 */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `YYYY-MM-DD` for a UTC year/month/day, avoiding local-timezone drift. */
function iso(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Saturday/Sunday, for column shading only — the server owns the real work week. */
function isWeekend(year: number, monthIndex: number, day: number): boolean {
  const dow = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
  return dow === 0 || dow === 6;
}

export function TeamLeaveCalendar() {
  const { client } = useAuth();
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [monthIndex, setMonthIndex] = useState(now.getUTCMonth());

  const total = daysInMonth(year, monthIndex);
  const from = iso(year, monthIndex, 1);
  const to = iso(year, monthIndex, total);

  const query = useQuery({
    queryKey: ["leave-calendar", from, to],
    queryFn: () =>
      client!.get<LeaveCalendarResponse>(`/v1/leave/calendar?from=${from}&to=${to}`),
    enabled: !!client,
  });

  /**
   * One row per person who is off at all this month, each carrying the set of
   * dates they are away. Grouping by employee rather than listing requests is the
   * whole point — two adjacent requests from one person are one absence to
   * whoever is arranging cover.
   */
  const rows = useMemo(() => {
    const byEmployee = new Map<string, { name: string; dates: Set<string>; items: LeaveRequest[] }>();
    for (const item of query.data?.items ?? []) {
      let row = byEmployee.get(item.employee_id);
      if (!row) {
        row = { name: item.employee_name, dates: new Set(), items: [] };
        byEmployee.set(item.employee_id, row);
      }
      row.items.push(item);
      for (let day = 1; day <= total; day += 1) {
        const date = iso(year, monthIndex, day);
        if (date >= item.start_date && date <= item.end_date) row.dates.add(date);
      }
    }
    return [...byEmployee.entries()]
      .map(([employeeId, row]) => ({ employeeId, ...row }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [query.data, year, monthIndex, total]);

  function shift(delta: number) {
    const next = monthIndex + delta;
    if (next < 0) {
      setMonthIndex(11);
      setYear(year - 1);
    } else if (next > 11) {
      setMonthIndex(0);
      setYear(year + 1);
    } else {
      setMonthIndex(next);
    }
  }

  return (
    <div>
      <PageHeader title="Leave calendar">
        <div className="flex items-center gap-2">
          <Button size="icon" variant="ghost" aria-label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-[9rem] text-center text-sm font-semibold text-fg">
            {MONTH_NAMES[monthIndex]} {year}
          </span>
          <Button size="icon" variant="ghost" aria-label="Next month" onClick={() => shift(1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </PageHeader>

      {query.isLoading ? (
        <LoadingState label="Loading leave calendar…" />
      ) : query.isError ? (
        <ErrorState error={query.error} />
      ) : rows.length === 0 ? (
        <EmptyState>{`Nobody is booked off in ${MONTH_NAMES[monthIndex]} ${year}.`}</EmptyState>
      ) : (
        // Horizontal scroll on the container, never on the page body: 31 day
        // columns will not fit a phone, and this screen has to work on one.
        <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-surface px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted">
                  Who
                </th>
                {Array.from({ length: total }, (_, i) => i + 1).map((day) => (
                  <th
                    key={day}
                    scope="col"
                    className={`w-7 px-0 py-2 text-center text-[0.65rem] font-semibold ${
                      isWeekend(year, monthIndex, day) ? "text-subtle" : "text-muted"
                    }`}
                  >
                    {day}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employeeId} className="border-t border-border">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 whitespace-nowrap bg-surface px-3 py-2 text-left font-medium text-fg"
                  >
                    {row.name}
                  </th>
                  {Array.from({ length: total }, (_, i) => i + 1).map((day) => {
                    const date = iso(year, monthIndex, day);
                    const off = row.dates.has(date);
                    return (
                      <td
                        key={day}
                        // The accessible label carries the whole fact, because a
                        // coloured cell says nothing to a screen reader.
                        aria-label={off ? `${row.name} is off on ${date}` : undefined}
                        title={off ? `${row.name} — ${date}` : undefined}
                        className={`h-8 border-l border-border px-0 text-center ${
                          off
                            ? "bg-accent"
                            : isWeekend(year, monthIndex, day)
                              ? "bg-surface-2"
                              : ""
                        }`}
                      >
                        <span className="sr-only">{off ? "off" : ""}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-subtle">
        Approved leave only. Requests still awaiting a decision are not shown, because this
        calendar answers who will actually be absent.
      </p>
    </div>
  );
}
