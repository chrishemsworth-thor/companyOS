import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Paperclip, Users } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { DetailGrid } from "../../components/DetailGrid";
import { Field } from "../../components/Field";
import { ErrorState, LoadingState } from "../../components/AsyncState";
import { formatDate } from "../../lib/format";
import type { LeaveRequestDetail as LeaveRequestDetailData } from "../../api/types";

/**
 * `/leave/requests/:id` — one leave request (PRD-006c).
 *
 * Not the screen a manager decides from: the approvals card carries everything a
 * decision needs, and PRD-007's whole point is not making anyone leave the inbox.
 * This exists because `subjectRoutes.ts` needs somewhere to send a *notification*
 * — in particular "your leave was cancelled", which has no approval behind it and
 * would otherwise render as unavailable.
 *
 * Access is the server's per-row rule (the employee, an approver on this row, a
 * `people:read` holder, or an admin); anyone else gets a 404, which `ErrorState`
 * renders as an explanation rather than an alarm.
 */

function formatDays(days: number): string {
  const label = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${label} ${days === 1 ? "day" : "days"}`;
}

export function LeaveRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();

  const query = useQuery({
    queryKey: ["leave-request", id],
    queryFn: () => client!.get<LeaveRequestDetailData>(`/v1/leave/requests/${id}`),
    enabled: !!client && !!id,
  });

  if (query.isLoading) return <LoadingState label="Loading leave request…" />;
  if (query.isError || !query.data) return <ErrorState error={query.error} />;

  const request = query.data;
  const spanLabel =
    request.start_date === request.end_date
      ? request.start_date
      : `${request.start_date} → ${request.end_date}`;

  return (
    <div>
      <BackLink to="/leave">Back to my leave</BackLink>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            Leave · {spanLabel}
            <StatusBadge status={request.state} />
          </span>
        }
      />

      <DetailGrid>
        <Field label="Employee">{request.employee_name}</Field>
        <Field label="Type">
          {request.balance?.leave_type_name ?? request.leave_type_code}
        </Field>
        <Field label="Working days">
          {formatDays(request.working_days)}
          {request.excluded_days.length > 0 && (
            <span className="ml-1.5 text-xs text-subtle">
              ({request.excluded_days.length} not worked)
            </span>
          )}
        </Field>
        <Field label="Half days">
          {request.start_half_day || request.end_half_day
            ? [request.start_half_day && "first day", request.end_half_day && "last day"]
                .filter(Boolean)
                .join(", ")
            : "—"}
        </Field>
        <Field label="Requested">{formatDate(request.created_at)}</Field>
        <Field label="Decided">{formatDate(request.decided_at)}</Field>
        {request.cancelled_at && (
          <Field label="Cancelled">{formatDate(request.cancelled_at)}</Field>
        )}
        <Field label="Reason">{request.reason ?? "—"}</Field>
        {request.balance_after_days !== null && (
          <Field label="Balance if approved">{formatDays(request.balance_after_days)}</Field>
        )}
        {request.attachment_file_id && (
          <Field label="Document">
            <a
              href={`/v1/files/${request.attachment_file_id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold"
            >
              <Paperclip className="size-3.5 shrink-0" aria-hidden />
              View
            </a>
          </Field>
        )}
      </DetailGrid>

      {request.team_overlaps.length > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-fg">
          <Users className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <div>
            <div className="font-semibold">Also off on these dates</div>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs">
              {request.team_overlaps.map((o) => (
                <li key={o.leave_request_id}>
                  {o.employee_name} — {o.start_date} to {o.end_date}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* The approval's own comment is the answer to "why was this refused",
          which is the reason somebody follows a notification here at all. */}
      {request.approval?.decision_comment && (
        <div className="mt-4 rounded-lg border border-border bg-surface p-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">
            Approver comment
          </div>
          <div className="mt-1 text-fg">{request.approval.decision_comment}</div>
        </div>
      )}
    </div>
  );
}
