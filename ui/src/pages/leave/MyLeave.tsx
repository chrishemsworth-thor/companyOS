import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, TriangleAlert, Users } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../components/Toast";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { NOTIFICATIONS_KEY } from "../../hooks/useNotifications";
import { ApiError } from "../../api/client";
import type {
  LeaveBalance,
  LeaveBalancesResponse,
  LeavePreview,
  LeaveRequest,
  LeaveRequestPage,
  LeaveType,
} from "../../api/types";

/**
 * `/leave` — the employee's own leave (PRD-006c).
 *
 * PRD-006's first goal: *"An employee can request leave and see their balance
 * without asking HR."* So balance and the request form are on one screen, and the
 * form previews before it submits — PRD-006 requires the computed working days be
 * shown **before** submission, and this page never guesses that number locally.
 * It asks `POST /v1/leave/preview` on every change, because the working-day count
 * depends on the tenant's work week and the employee's state holidays, and a
 * client that reimplemented that would drift from the server the day S6 lands.
 *
 * Reachable by the self-service tier, which holds no business capability at all —
 * everything here is on the `self` axis.
 */

/** Today in the browser's timezone, as YYYY-MM-DD, for the date inputs' floor. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDays(days: number): string {
  const label = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${label} ${days === 1 ? "day" : "days"}`;
}

export function MyLeave() {
  const { client } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [leaveTypeCode, setLeaveTypeCode] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [startHalfDay, setStartHalfDay] = useState(false);
  const [endHalfDay, setEndHalfDay] = useState(false);
  const [reason, setReason] = useState("");

  const typesQuery = useQuery({
    queryKey: ["leave-types"],
    queryFn: () => client!.get<{ items: LeaveType[] }>("/v1/leave/types"),
    enabled: !!client,
  });

  const balancesQuery = useQuery({
    queryKey: ["leave-balances", "me"],
    queryFn: () => client!.get<LeaveBalancesResponse>("/v1/leave/balances"),
    enabled: !!client,
  });

  const requestsQuery = useQuery({
    queryKey: ["leave-requests", "mine"],
    queryFn: () => client!.get<LeaveRequestPage>("/v1/leave/requests?scope=mine&limit=100"),
    enabled: !!client,
  });

  const types = typesQuery.data?.items ?? [];
  const selectedType = types.find((t) => t.code === leaveTypeCode) ?? null;

  // Default to the first type once they load, so the form is usable immediately
  // rather than starting on an empty select the user has to notice.
  useEffect(() => {
    if (!leaveTypeCode && types.length > 0) setLeaveTypeCode(types[0]!.code);
  }, [leaveTypeCode, types]);

  // A half-day flag left set while switching to a whole-day-only type would
  // silently submit something the server refuses, so clear it on the switch.
  useEffect(() => {
    if (selectedType && !selectedType.allows_half_day) {
      setStartHalfDay(false);
      setEndHalfDay(false);
    }
  }, [selectedType]);

  const canPreview = Boolean(leaveTypeCode && startDate && endDate && startDate <= endDate);

  const previewQuery = useQuery({
    queryKey: [
      "leave-preview",
      leaveTypeCode,
      startDate,
      endDate,
      startHalfDay,
      endHalfDay,
      Boolean(selectedType?.requires_attachment),
    ],
    queryFn: () =>
      client!.post<LeavePreview>("/v1/leave/preview", {
        leave_type_code: leaveTypeCode,
        start_date: startDate,
        end_date: endDate,
        start_half_day: startHalfDay,
        end_half_day: endHalfDay,
        // No upload on this screen yet, so a type needing a medical certificate
        // previews honestly as blocked rather than looking submittable.
        has_attachment: false,
      }),
    enabled: !!client && canPreview,
    retry: false,
  });

  const preview = previewQuery.data ?? null;
  const blockers = preview?.blockers ?? [];

  const submit = useMutation({
    mutationFn: () =>
      client!.post<LeaveRequest>("/v1/leave/requests", {
        leave_type_code: leaveTypeCode,
        start_date: startDate,
        end_date: endDate,
        start_half_day: startHalfDay,
        end_half_day: endHalfDay,
        ...(reason ? { reason } : {}),
      }),
    onSuccess: async () => {
      toast.success("Leave requested — your manager has been notified.");
      setStartDate("");
      setEndDate("");
      setStartHalfDay(false);
      setEndHalfDay(false);
      setReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["leave-balances"] }),
        queryClient.invalidateQueries({ queryKey: ["leave-requests"] }),
        queryClient.invalidateQueries({ queryKey: ["approvals"] }),
      ]);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not request leave"),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => client!.post<{ outcome: string }>(`/v1/leave/requests/${id}/cancel`),
    onSuccess: async (result) => {
      toast.success(
        result.outcome === "cancellation_pending"
          ? "Cancellation sent to your manager — the leave stays booked until they agree."
          : "Leave request withdrawn.",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["leave-balances"] }),
        queryClient.invalidateQueries({ queryKey: ["leave-requests"] }),
        queryClient.invalidateQueries({ queryKey: ["approvals"] }),
        queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
      ]);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not cancel"),
  });

  const requests = requestsQuery.data?.items ?? [];
  const policyUnconfigured = useMemo(
    () => (balancesQuery.data?.items ?? []).some((b) => b.entitlement_source === "default"),
    [balancesQuery.data],
  );

  return (
    <div>
      <PageHeader title="My leave" />

      {/* Said once at the top rather than on every balance tile: while leave
          policy is unconfigured every number on this page is a provisional
          default, and presenting those as entitlement is how an employee ends up
          trusting a figure nobody set. */}
      {policyUnconfigured && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
          <span>
            Leave policy has not been set up for this company yet, so these entitlements are
            provisional defaults. Ask an administrator to configure leave policy.
          </span>
        </div>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Balances</h2>
        {balancesQuery.isLoading ? (
          <LoadingState label="Loading balances…" />
        ) : balancesQuery.isError ? (
          <ErrorState error={balancesQuery.error} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(balancesQuery.data?.items ?? []).map((b) => (
              <BalanceTile key={b.leave_type_code} balance={b} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-6 rounded-lg border border-border bg-surface p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Request leave
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-fg">Type</span>
            <select
              value={leaveTypeCode}
              onChange={(e) => setLeaveTypeCode(e.target.value)}
              className="h-10 rounded-md border border-border-strong bg-surface px-3 text-sm text-fg"
            >
              {types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                  {t.paid ? "" : " (unpaid)"}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-fg">Dates</span>
            <div className="flex items-center gap-2">
              <input
                type="date"
                aria-label="Start date"
                min={today()}
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  // A start after the end is never what someone meant; pulling
                  // the end along beats showing them a validation error.
                  if (endDate && e.target.value > endDate) setEndDate(e.target.value);
                }}
                className="h-10 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 text-sm text-fg"
              />
              <span className="text-subtle">→</span>
              <input
                type="date"
                aria-label="End date"
                min={startDate || today()}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-10 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 text-sm text-fg"
              />
            </div>
          </div>
        </div>

        {selectedType?.allows_half_day && (
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={startHalfDay}
                onChange={(e) => setStartHalfDay(e.target.checked)}
              />
              <span className="text-fg">Half day on the first day</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={endHalfDay}
                onChange={(e) => setEndHalfDay(e.target.checked)}
              />
              <span className="text-fg">Half day on the last day</span>
            </label>
          </div>
        )}

        <label className="mt-3 flex flex-col gap-1 text-sm">
          <span className="font-medium text-fg">Reason (optional)</span>
          <input
            type="text"
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
            className="h-10 rounded-md border border-border-strong bg-surface px-3 text-sm text-fg"
          />
        </label>

        {/* The "computed working days shown before submission" requirement. */}
        {canPreview && preview && (
          <div className="mt-4 rounded-md bg-surface-2 p-3 text-sm">
            <div className="font-semibold text-fg">
              {formatDays(preview.working_days)} of leave
              {preview.excluded_days.length > 0 && (
                <span className="ml-1.5 font-normal text-subtle">
                  — {preview.calendar_days} calendar days, {preview.excluded_days.length} not worked
                </span>
              )}
            </div>
            <div className="mt-1 text-muted">
              {formatDays(preview.balance_after_days)} of {preview.balance.leave_type_name} left if
              this is approved.
            </div>

            {preview.team_overlaps.length > 0 && (
              <div className="mt-2 flex items-start gap-2 rounded-md bg-warn-bg px-2.5 py-2 text-xs text-fg">
                <Users className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                <div>
                  {/* A warning, never a block. The employee can still submit —
                      PRD-006 is explicit that this does not stop anyone. */}
                  <span className="font-semibold">Also off then: </span>
                  {preview.team_overlaps.map((o) => o.employee_name).join(", ")}
                </div>
              </div>
            )}

            {blockers.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-xs text-bad">
                {blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* A 422/409 from preview (an unknown type, say) surfaces here rather
            than silently leaving the button enabled. */}
        {previewQuery.isError && (
          <div className="mt-3 text-xs text-bad">
            {previewQuery.error instanceof ApiError
              ? previewQuery.error.message
              : "Could not work out the leave days for those dates."}
          </div>
        )}

        <div className="mt-4">
          <Button
            variant="primary"
            icon={<CalendarPlus className="size-4" />}
            loading={submit.isPending}
            // Disabled on any blocker, because the server runs the identical
            // check and would refuse — an enabled button that always fails is
            // worse than a disabled one that explains itself above.
            disabled={!canPreview || !preview || blockers.length > 0 || previewQuery.isError}
            onClick={() => submit.mutate()}
          >
            Request leave
          </Button>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          My requests
        </h2>
        {requestsQuery.isLoading ? (
          <LoadingState label="Loading requests…" />
        ) : requestsQuery.isError ? (
          <ErrorState error={requestsQuery.error} />
        ) : requests.length === 0 ? (
          <EmptyState>You have not requested any leave yet.</EmptyState>
        ) : (
          <div className="flex flex-col gap-2">
            {requests.map((r) => (
              <div
                key={r.leave_request_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3 shadow-sm"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">
                      {r.start_date}
                      {r.start_date !== r.end_date && ` → ${r.end_date}`}
                    </span>
                    <StatusBadge status={r.state} />
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {r.leave_type_code} · {formatDays(r.working_days)}
                    {r.reason && ` · ${r.reason}`}
                  </div>
                </div>
                {/* Only live requests can be withdrawn. An approved one goes back
                    to the manager rather than vanishing, which the toast says. */}
                {(r.state === "pending" || r.state === "approved") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={cancel.isPending && cancel.variables === r.leave_request_id}
                    onClick={() => cancel.mutate(r.leave_request_id)}
                  >
                    {r.state === "pending" ? "Withdraw" : "Request cancellation"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function BalanceTile({ balance }: { balance: LeaveBalance }) {
  const total = balance.entitlement_days + balance.carry_forward_days;
  return (
    <div className="rounded-lg border border-border bg-surface p-3 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        {balance.leave_type_name}
      </div>
      <div className="mt-1 text-2xl font-semibold text-fg">
        {Number.isInteger(balance.available_days)
          ? balance.available_days
          : balance.available_days.toFixed(1)}
        <span className="ml-1 text-sm font-normal text-subtle">of {total} left</span>
      </div>
      <div className="mt-1 text-xs text-muted">
        {formatDays(balance.taken_days)} taken
        {balance.pending_days > 0 && ` · ${formatDays(balance.pending_days)} pending`}
      </div>
    </div>
  );
}
