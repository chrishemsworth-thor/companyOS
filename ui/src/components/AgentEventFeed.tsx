import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncState";
import { formatDate, formatCents } from "../lib/format";
import type { AgentEvent, CollectionsDecisionPayload, RiskFlaggedPayload } from "../api/types";

/** Event types that tell the collections story: cause → decision → escalation. */
export const AGENT_EVENT_TYPES = [
  "collections.decision",
  "customer.risk_flagged",
  "invoice.overdue",
  "invoice.sent",
] as const;

interface FeedPage {
  items: AgentEvent[];
  next_cursor: string | null;
}

function eventBadge(event: AgentEvent): { label: string; tone: string } {
  switch (event.event_type) {
    case "collections.decision": {
      const action = (event.payload as unknown as CollectionsDecisionPayload).action;
      return {
        label: action,
        tone: action === "escalate" ? "bad" : action === "remind" ? "warn" : "neutral",
      };
    }
    case "customer.risk_flagged":
      return { label: "risk flagged", tone: "bad" };
    case "invoice.overdue":
      return { label: "overdue", tone: "warn" };
    case "invoice.sent":
      return { label: "sent", tone: "good" };
    default:
      return { label: event.event_type, tone: "neutral" };
  }
}

function EventSummary({ event, showCustomer }: { event: AgentEvent; showCustomer: boolean }) {
  const payload = event.payload;
  const customerLink =
    showCustomer && typeof payload.customer_id === "string" ? (
      <Link to={`/customers/${payload.customer_id}`}>{payload.customer_id}</Link>
    ) : null;

  if (event.event_type === "collections.decision") {
    const p = payload as unknown as CollectionsDecisionPayload;
    return (
      <span className="activity-body">
        {customerLink} risk {p.risk_score}/100 · via {p.channel} ·{" "}
        <span className="badge badge-neutral">{p.source}</span>
        {p.message && (
          <details className="event-message">
            <summary>message</summary>
            {p.message}
          </details>
        )}
      </span>
    );
  }
  if (event.event_type === "customer.risk_flagged") {
    const p = payload as unknown as RiskFlaggedPayload;
    return (
      <span className="activity-body">
        {customerLink} risk {p.risk_score}/100 · {p.open_invoices.length} open invoice
        {p.open_invoices.length === 1 ? "" : "s"} · {formatCents(p.total_due_cents)} due
      </span>
    );
  }
  if (event.event_type === "invoice.overdue" || event.event_type === "invoice.sent") {
    const invoiceId = typeof payload.invoice_id === "string" ? payload.invoice_id : null;
    return (
      <span className="activity-body">
        {customerLink}{" "}
        {invoiceId && <Link to={`/invoices/${invoiceId}`}>{invoiceId}</Link>}
        {typeof payload.days_overdue === "number" && ` · ${payload.days_overdue}d overdue`}
      </span>
    );
  }
  return <span className="activity-body">{customerLink}</span>;
}

export function AgentEventFeed({
  customerId,
  invoiceId,
  types = [...AGENT_EVENT_TYPES],
  showCustomer = true,
}: {
  customerId?: string;
  invoiceId?: string;
  types?: string[];
  showCustomer?: boolean;
}) {
  const { client } = useAuth();
  const query = useInfiniteQuery({
    queryKey: ["events", { customerId, invoiceId, types }],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ type: types.join(",") });
      if (customerId) params.set("customer_id", customerId);
      if (invoiceId) params.set("invoice_id", invoiceId);
      if (pageParam) params.set("cursor", pageParam);
      return client!.get<FeedPage>(`/v1/events?${params}`);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!client,
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;
  const events = query.data?.pages.flatMap((p) => p.items) ?? [];
  if (events.length === 0) return <EmptyState>No agent activity yet.</EmptyState>;

  return (
    <div>
      <ul className="activity-feed">
        {events.map((event) => {
          const badge = eventBadge(event);
          return (
            <li key={event.event_id}>
              <span className={`badge badge-${badge.tone}`}>{badge.label}</span>
              <EventSummary event={event} showCustomer={showCustomer} />
              <span className="activity-time">{formatDate(event.occurred_at)}</span>
            </li>
          );
        })}
      </ul>
      {query.hasNextPage && (
        <button
          className="btn btn-sm"
          style={{ marginTop: "0.6rem" }}
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
