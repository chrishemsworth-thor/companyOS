import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState, EmptyState } from "../components/AsyncState";
import { Badge, type Tone } from "./Badge";
import { Button } from "./Button";
import { formatDate, formatCents } from "../lib/format";
import type {
  AgentEvent,
  CollectionsDecisionPayload,
  GuardrailOverridePayload,
  RiskFlaggedPayload,
} from "../api/types";

/** Event types that tell the collections story: cause → decision → escalation. */
export const AGENT_EVENT_TYPES = [
  "collections.decision",
  "guardrail.override",
  "customer.risk_flagged",
  "invoice.overdue",
  "invoice.sent",
] as const;

/** Plain-language names for the guardrails, for a reader who did not write them. */
const GUARDRAIL_LABELS: Record<string, string> = {
  reminder_cap: "reminder cap",
  contact_window: "outside business hours",
  escalation_gate: "escalation too early",
  invoice_reference: "wrong invoice cited",
  message_length: "message too long",
};

function guardrailLabel(guardrail: string): string {
  return GUARDRAIL_LABELS[guardrail] ?? guardrail.replace(/_/g, " ");
}

interface FeedPage {
  items: AgentEvent[];
  next_cursor: string | null;
}

function eventBadge(event: AgentEvent): { label: string; tone: Tone } {
  switch (event.event_type) {
    case "collections.decision": {
      const action = (event.payload as unknown as CollectionsDecisionPayload).action;
      return {
        label: action,
        tone: action === "escalate" ? "bad" : action === "remind" ? "warn" : "neutral",
      };
    }
    case "guardrail.override": {
      const p = event.payload as unknown as GuardrailOverridePayload;
      // A deferral is the guard working as designed; a suppression stopped a
      // send outright. Neither is an error, so neither is red.
      return { label: `guardrail · ${p.outcome}`, tone: p.outcome === "deferred" ? "neutral" : "warn" };
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
      <span className="min-w-0 flex-1 text-muted">
        {customerLink} risk {p.risk_score}/100 · via {p.channel} ·{" "}
        {/* PRD-002: fallback and override badges on the Agent Activity feed. The
            fallback badge is the one a tenant admin needs to trust the agent —
            it says "no model decided this, the template did". */}
        <Badge tone={p.source === "fallback" ? "warn" : "neutral"} dot={false}>
          {p.source === "fallback" ? "fallback" : "llm"}
        </Badge>
        {p.guardrail_overridden && (
          <>
            {" "}
            <Badge tone="warn" dot={false}>
              guardrail: {(p.overrides ?? []).map(guardrailLabel).join(", ") || "overridden"}
            </Badge>
          </>
        )}
        {p.model && <span className="ml-1 text-xs text-subtle">{p.model}</span>}
        {p.message && (
          <details className="mt-1 text-sm">
            <summary className="cursor-pointer text-accent">message</summary>
            <div className="mt-1 whitespace-pre-wrap">{p.message}</div>
            {/* What it cost and how it was reached, for the operator who wants
                to know before leaving the agent running. */}
            <div className="mt-1 text-xs text-subtle">
              {p.provider ?? "no provider"}
              {p.prompt_version ? ` · prompt ${p.prompt_version}` : ""}
              {typeof p.latency_ms === "number" ? ` · ${p.latency_ms}ms` : ""}
              {typeof p.input_tokens === "number"
                ? ` · ${p.input_tokens}/${p.output_tokens ?? 0} tokens`
                : ""}
              {typeof p.cost_micros === "number" ? ` · $${(p.cost_micros / 1e6).toFixed(6)}` : ""}
              {p.fallback_reason ? ` · fallback: ${p.fallback_reason}` : ""}
            </div>
          </details>
        )}
      </span>
    );
  }
  if (event.event_type === "guardrail.override") {
    const p = payload as unknown as GuardrailOverridePayload;
    return (
      <span className="min-w-0 flex-1 text-muted">
        {showCustomer && p.subject_id ? (
          <Link to={`/customers/${p.subject_id}`}>{p.subject_id}</Link>
        ) : null}{" "}
        {guardrailLabel(p.guardrail)}
        {p.from_action && p.to_action && p.from_action !== p.to_action
          ? ` · ${p.from_action} → ${p.to_action}`
          : ""}
        {p.subject_ref && (
          <>
            {" · "}
            <Link to={`/invoices/${p.subject_ref}`}>{p.subject_ref}</Link>
          </>
        )}
        <div className="mt-1 text-xs text-subtle">
          {p.detail}
          {p.defer_until ? ` · retrying ${formatDate(p.defer_until)}` : ""}
        </div>
      </span>
    );
  }
  if (event.event_type === "customer.risk_flagged") {
    const p = payload as unknown as RiskFlaggedPayload;
    return (
      <span className="min-w-0 flex-1 text-muted">
        {customerLink} risk {p.risk_score}/100 · {p.open_invoices.length} open invoice
        {p.open_invoices.length === 1 ? "" : "s"} · {formatCents(p.total_due_cents)} due
      </span>
    );
  }
  if (event.event_type === "invoice.overdue" || event.event_type === "invoice.sent") {
    const invoiceId = typeof payload.invoice_id === "string" ? payload.invoice_id : null;
    return (
      <span className="min-w-0 flex-1 text-muted">
        {customerLink}{" "}
        {invoiceId && <Link to={`/invoices/${invoiceId}`}>{invoiceId}</Link>}
        {typeof payload.days_overdue === "number" && ` · ${payload.days_overdue}d overdue`}
      </span>
    );
  }
  return <span className="min-w-0 flex-1 text-muted">{customerLink}</span>;
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
      <ul className="flex list-none flex-col gap-2 p-0">
        {events.map((event) => {
          const badge = eventBadge(event);
          return (
            <li
              key={event.event_id}
              className="flex items-baseline gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-sm"
            >
              <Badge tone={badge.tone}>{badge.label}</Badge>
              <EventSummary event={event} showCustomer={showCustomer} />
              <span className="shrink-0 text-xs text-subtle">{formatDate(event.occurred_at)}</span>
            </li>
          );
        })}
      </ul>
      {query.hasNextPage && (
        <div className="mt-3">
          <Button
            size="sm"
            onClick={() => void query.fetchNextPage()}
            loading={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
