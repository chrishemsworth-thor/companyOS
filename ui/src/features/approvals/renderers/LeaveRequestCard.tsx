import { useQuery } from "@tanstack/react-query";
import { CalendarDays, CircleAlert, Paperclip, TriangleAlert, Users } from "lucide-react";
import { useAuth } from "../../../auth/AuthContext";
import type { LeaveRequestDetail } from "../../../api/types";
import type { ApprovalRendererProps } from "./types";

/**
 * The `leave_request` context card (PRD-006c, plugged into PRD-007's registry).
 *
 * PRD-006's manager story is the spec: *"I want to see who else in my team is off
 * on those dates before I approve so that I do not leave the team uncovered."*
 * And PRD-006's goal is 30 seconds on a phone. So everything a decision needs is
 * on the card — dates, working days, **remaining balance after approval**,
 * **overlapping team leave**, the reason and the attachment — and there is
 * nothing worth clicking through to.
 *
 * It fetches its own subject, as `ApprovalRendererProps` intends: the inbox shell
 * knows nothing about leave, which is what makes "adding a new approvable type
 * costs one renderer file" true.
 *
 * `GET /v1/leave/requests/:id` is on the `self` capability module with per-row
 * authorization, so this works for an approver whose role grants no
 * `people:read` — a team lead on the self-service tier. That is deliberate and is
 * why the route is not under `/v1/people`.
 */
export function LeaveRequestCard({ approval }: ApprovalRendererProps) {
  const { client } = useAuth();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["leave-request", approval.subject_id],
    queryFn: () => client!.get<LeaveRequestDetail>(`/v1/leave/requests/${approval.subject_id}`),
    enabled: !!client,
  });

  if (isLoading) {
    return <div className="text-sm text-subtle">Loading leave details…</div>;
  }

  // PRD-007's criterion that a subject which has gone away "renders as
  // unavailable rather than erroring". A cancelled request the approver can no
  // longer read lands here too.
  if (isError || !data) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
        <span>This leave request is no longer available.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-subtle">Employee</dt>
        <dd className="font-medium text-fg">{data.employee_name}</dd>

        <dt className="text-subtle">Type</dt>
        <dd className="text-fg">{data.balance?.leave_type_name ?? data.leave_type_code}</dd>

        <dt className="text-subtle">Dates</dt>
        <dd className="text-fg">{formatSpan(data)}</dd>

        <dt className="text-subtle">Working days</dt>
        <dd className="font-medium text-fg">
          {formatDays(data.working_days)}
          {data.excluded_days.length > 0 && (
            // Showing the arithmetic, not just the answer: an office manager who
            // cannot see why 7 days became 5 does not trust the 5.
            <span className="ml-1.5 text-xs text-subtle">
              ({data.excluded_days.length} non-working{" "}
              {data.excluded_days.length === 1 ? "day" : "days"} excluded)
            </span>
          )}
        </dd>

        {data.balance_after_days !== null && (
          <>
            <dt className="text-subtle">Balance if approved</dt>
            <dd className={data.balance_after_days < 0 ? "font-medium text-bad" : "text-fg"}>
              {formatDays(data.balance_after_days)} left
              {data.balance && (
                <span className="ml-1.5 text-xs text-subtle">
                  (of {formatDays(data.balance.entitlement_days + data.balance.carry_forward_days)})
                </span>
              )}
            </dd>
          </>
        )}

        {data.reason && (
          <>
            <dt className="text-subtle">Reason</dt>
            <dd className="text-fg">{data.reason}</dd>
          </>
        )}
      </dl>

      {/* The manager's actual question — who is left covering. A warning, never
          a block (PRD-006: "warn, do not block"), so the wording informs rather
          than objects. */}
      {data.team_overlaps.length > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-warn-bg px-3 py-2 text-xs text-fg">
          <Users className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <div>
            <div className="font-semibold">Also off on these dates</div>
            <ul className="mt-1 flex flex-col gap-0.5">
              {data.team_overlaps.map((o) => (
                <li key={o.leave_request_id}>
                  {o.employee_name} — {o.start_date} to {o.end_date}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {data.attachment_file_id && (
        <a
          href={`/v1/files/${data.attachment_file_id}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 text-xs font-semibold"
        >
          <Paperclip className="size-3.5 shrink-0" aria-hidden />
          View supporting document
        </a>
      )}

      {/* Provisional numbers must not read as policy. While leave policy is
          unconfigured the entitlement is a default the server supplied, and a
          manager approving against it deserves to know. */}
      {data.balance?.entitlement_source === "default" && (
        <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
          <span>
            Leave policy is not configured for this company, so the balance shown is a
            provisional default rather than an entitlement anyone set.
          </span>
        </div>
      )}

      {data.state === "cancellation_pending" && (
        <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
          <CalendarDays className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
          <span>
            This leave is already approved. {data.employee_name} is asking to cancel it —
            approving gives the days back, rejecting keeps the leave booked.
          </span>
        </div>
      )}
    </div>
  );
}

/** `1 Mar 2027 – 3 Mar 2027`, with half-day ends marked. */
function formatSpan(request: {
  start_date: string;
  end_date: string;
  start_half_day: boolean;
  end_half_day: boolean;
}): string {
  const start = `${request.start_date}${request.start_half_day ? " (half day)" : ""}`;
  if (request.start_date === request.end_date) {
    // A single day with either flag set is a half day; saying it twice would be
    // noise.
    return request.start_half_day || request.end_half_day
      ? `${request.start_date} (half day)`
      : request.start_date;
  }
  return `${start} → ${request.end_date}${request.end_half_day ? " (half day)" : ""}`;
}

/** `2.5` not `2.50`, and `3` not `3.0` — half days are the only fraction. */
function formatDays(days: number): string {
  const label = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${label} ${days === 1 ? "day" : "days"}`;
}
