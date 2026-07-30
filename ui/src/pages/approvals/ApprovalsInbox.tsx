import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, BellRing, CheckCircle2, Inbox } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../components/Toast";
import { Button } from "../../components/Button";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { useUserNames } from "../../hooks/useUserNames";
import { NOTIFICATIONS_KEY } from "../../hooks/useNotifications";
import { ApprovalCard } from "../../features/approvals/ApprovalCard";
import { subjectLabel } from "../../lib/subjectRoutes";
import { ApiError } from "../../api/client";
import type { Approval } from "../../api/types";

/**
 * `/approvals` — the approvals inbox (PRD-007).
 *
 * One screen showing everything awaiting a user's action across every module.
 * The whole point is *time to decide*: PRD-007's success metric is a manager
 * deciding a leave request in under 30 seconds, on a phone, from a notification.
 * So the list is flat, oldest first, with age prominent, and the decision
 * controls are on the card rather than behind a drill-in.
 *
 * The shell is generic. Nothing here knows what a leave request or an expense
 * claim is — that lives in the renderer registry, which is why S5, S7 and S9 each
 * add one file and touch nothing on this page.
 */

type Tab = "awaiting" | "mine" | "history";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "awaiting", label: "Awaiting me" },
  { id: "mine", label: "My requests" },
  { id: "history", label: "History" },
];

interface ApprovalPage {
  items: Approval[];
  next_cursor: string | null;
}

/**
 * Query per tab.
 *
 * "Awaiting me" and "History" both read `?mine=true` — the difference is state,
 * and history is *decided* items, not everything ever. `?state=` takes one value,
 * so history is fetched unfiltered and split client-side; the alternative is
 * three requests to build one list.
 */
function pathForTab(tab: Tab): string {
  switch (tab) {
    case "awaiting":
      return "/v1/approvals?mine=true&state=pending&limit=100";
    case "mine":
      return "/v1/approvals?requester=me&limit=100";
    case "history":
      return "/v1/approvals?mine=true&limit=100";
  }
}

export function ApprovalsInbox() {
  const { client, user } = useAuth();
  const [tab, setTab] = useState<Tab>("awaiting");
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();
  const toast = useToast();
  const userName = useUserNames();

  const queryKey = ["approvals", tab] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => client!.get<ApprovalPage>(pathForTab(tab)),
    enabled: !!client,
  });

  /** Refresh this tab, every other tab, and the bell — a decision moves all three. */
  async function refreshAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["approvals"] }),
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
    ]);
  }

  /**
   * Approve/reject with an optimistic removal and rollback on failure — the
   * pattern the deals stage-move already uses (`pages/crm/DealDetail.tsx`).
   *
   * The 409 case is the one PRD-007 calls out by name: two managers open the same
   * request, one decides, the other's click fails. The item has to come *back* on
   * screen with an explanation, because silently dropping it would leave the
   * second manager believing they made a decision they did not make.
   */
  const decide = useMutation({
    mutationFn: (vars: { id: string; decision: "approve" | "reject"; comment: string }) =>
      client!.post<Approval>(
        `/v1/approvals/${vars.id}/${vars.decision}`,
        vars.comment ? { comment: vars.comment } : {},
      ),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ApprovalPage>(queryKey);
      if (previous) {
        queryClient.setQueryData<ApprovalPage>(queryKey, {
          ...previous,
          items: previous.items.filter((a) => a.approval_id !== vars.id),
        });
      }
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
      if (err instanceof ApiError && err.status === 409) {
        toast.error(
          "Already handled",
          "Somebody else decided this request first. It is back in the list with its current state.",
        );
      } else {
        toast.error(
          "Could not record your decision",
          err instanceof Error ? err.message : "Please try again.",
        );
      }
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.decision === "approve" ? "Approved" : "Rejected");
    },
    onSettled: refreshAll,
  });

  const nudgeMutation = useMutation({
    mutationFn: (id: string) => client!.post(`/v1/approvals/${id}/nudge`),
    onSuccess: () => toast.success("Reminder sent"),
    onError: (err) => {
      // 429 is the 24h cooldown, and it is a *reasonable* answer rather than a
      // failure — the message says so instead of reading like a bug.
      if (err instanceof ApiError && err.status === 429) {
        toast.error("Already reminded", "You nudged this request in the last 24 hours.");
      } else {
        toast.error("Could not send the reminder", err instanceof Error ? err.message : "");
      }
    },
    onSettled: refreshAll,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => client!.post(`/v1/approvals/${id}/cancel`),
    onSuccess: () => toast.success("Request withdrawn"),
    onError: (err) =>
      toast.error("Could not withdraw the request", err instanceof Error ? err.message : ""),
    onSettled: refreshAll,
  });

  const all = query.data?.items ?? [];

  /** Tab scoping the API cannot express, then the client-side filters. */
  const visible = useMemo(() => {
    let rows = all;
    if (tab === "history") rows = rows.filter((a) => a.state !== "pending");
    if (typeFilter) rows = rows.filter((a) => a.subject_type === typeFilter);
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      rows = rows.filter((a) => userName(a.requested_by).toLowerCase().includes(needle));
    }
    // History reads best newest-decision-first; the queues read oldest-first,
    // which is the API's own order.
    return tab === "history" ? [...rows].reverse() : rows;
  }, [all, tab, typeFilter, search, userName]);

  /** Filter options come from what is actually in the list, not a hardcoded enum. */
  const presentTypes = useMemo(
    () => [...new Set(all.map((a) => a.subject_type))].sort(),
    [all],
  );

  return (
    <div>
      <h1>Approvals</h1>

      <div
        role="tablist"
        aria-label="Approvals"
        className="mb-4 flex snap-x snap-mandatory gap-1 overflow-x-auto border-b border-border"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px shrink-0 snap-start cursor-pointer border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
              tab === t.id
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {presentTypes.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <select
            aria-label="Filter by type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-10 cursor-pointer rounded-md border border-border bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All types</option>
            {presentTypes.map((t) => (
              <option key={t} value={t}>
                {subjectLabel(t)}
              </option>
            ))}
          </select>
          <input
            type="search"
            aria-label="Search by requester name"
            placeholder="Search by requester…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 flex-1 rounded-md border border-border bg-surface px-3 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring sm:max-w-xs"
          />
        </div>
      )}

      {query.isLoading && <LoadingState label="Loading approvals…" />}
      {query.error && <ErrorState error={query.error} />}

      {query.data && visible.length === 0 && <EmptyStateForTab tab={tab} filtered={all.length > 0} />}

      <div className="flex flex-col gap-3">
        {visible.map((approval) => (
          <ApprovalCard
            key={approval.approval_id}
            approval={approval}
            userName={userName}
            onDecide={
              // Only decidable in the queue, and only while pending. A user's own
              // request is never decidable from "My requests" even when they are
              // the approver — the API blocks self-approval for non-admins, and
              // offering the button anyway would be a trap.
              tab === "awaiting" && approval.state === "pending"
                ? (decision, comment) =>
                    decide.mutate({ id: approval.approval_id, decision, comment })
                : undefined
            }
            deciding={decide.isPending}
            actions={
              tab === "mine" ? (
                <RequesterActions
                  approval={approval}
                  approverName={userName(approval.approver_user_id)}
                  onNudge={() => nudgeMutation.mutate(approval.approval_id)}
                  onCancel={() => cancelMutation.mutate(approval.approval_id)}
                  busy={nudgeMutation.isPending || cancelMutation.isPending}
                />
              ) : undefined
            }
          />
        ))}
      </div>

      {tab === "awaiting" && visible.length > 0 && (
        <p className="mt-4 text-sm text-subtle">
          Oldest first — {visible.length} waiting on {user?.display_name ?? "you"}.
        </p>
      )}
    </div>
  );
}

/**
 * The My-requests footer (PRD-007 § "P0 — Requester visibility").
 *
 * "Who is my request with, and how long has it been there" is the whole reason
 * this tab exists: without it a requester chases on WhatsApp, which is exactly
 * the behaviour the module is meant to replace.
 */
function RequesterActions({
  approval,
  approverName,
  onNudge,
  onCancel,
  busy,
}: {
  approval: Approval;
  approverName: string;
  onNudge: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-2 border-t border-border pt-2 sm:flex-row sm:items-center">
      <span className="flex-1 text-sm text-muted">
        With <span className="font-semibold text-fg">{approverName}</span>
        {approval.state !== "pending" && ` · ${approval.state}`}
      </span>
      {approval.state === "pending" && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="secondary"
            onClick={onNudge}
            disabled={busy}
            icon={<BellRing className="size-4" />}
            className="w-full sm:w-auto"
          >
            Nudge
          </Button>
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={busy}
            icon={<Ban className="size-4" />}
            className="w-full sm:w-auto"
          >
            Withdraw
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Per-tab empty states.
 *
 * PRD-007 asks for "a genuine empty state" and for the bell's to "say something
 * useful, not 'no notifications'". An empty approvals queue is good news and
 * should read that way; an empty *filtered* list is a different thing entirely
 * and must not look like an empty queue, or a user will conclude their filter
 * found nothing when in fact they have work waiting.
 */
function EmptyStateForTab({ tab, filtered }: { tab: Tab; filtered: boolean }) {
  if (filtered) {
    return <EmptyState icon={<Inbox className="size-6" />}>Nothing matches those filters.</EmptyState>;
  }
  if (tab === "awaiting") {
    return (
      <EmptyState icon={<CheckCircle2 className="size-6" />}>
        Nothing needs your decision. Requests routed to you appear here, newest at the bottom.
      </EmptyState>
    );
  }
  if (tab === "mine") {
    return (
      <EmptyState icon={<Inbox className="size-6" />}>
        You have not raised anything for approval. Claims and leave requests you submit show up here
        with whoever they are waiting on.
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<Inbox className="size-6" />}>
      No decisions yet. Everything you approve or reject is kept here.
    </EmptyState>
  );
}
