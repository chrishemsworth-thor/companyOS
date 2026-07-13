import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState, EmptyState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { FormError } from "../../components/FormError";
import { useApiMutation } from "../../hooks/useApiMutation";
import { formatDate } from "../../lib/format";
import type {
  MessageAuthor,
  TicketDetail as TicketDetailType,
  TicketStatus,
} from "../../api/types";

/** Mirrors the backend state machine (src/modules/support/state-machine.ts). */
const LEGAL_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ["pending", "resolved"],
  pending: ["open", "resolved"],
  resolved: ["closed", "open"],
  closed: [],
};

export function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const [author, setAuthor] = useState<MessageAuthor>("agent");
  const [body, setBody] = useState("");

  const query = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => client!.get<TicketDetailType>(`/v1/tickets/${id}`),
    enabled: !!client && !!id,
  });

  const replyMutation = useApiMutation({
    mutationFn: (apiClient, vars: { author: MessageAuthor; body: string }) =>
      apiClient.post(`/v1/tickets/${id}/messages`, vars),
    invalidates: () => [["ticket", id], ["tickets"]],
    onSuccess: () => setBody(""),
  });

  const statusMutation = useApiMutation({
    mutationFn: (apiClient, status: TicketStatus) =>
      apiClient.post(`/v1/tickets/${id}/status`, { status }),
    invalidates: () => [["ticket", id], ["tickets"]],
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;
  const ticket = query.data;
  if (!ticket) return null;

  const nextStatuses = LEGAL_TRANSITIONS[ticket.status] ?? [];

  return (
    <div>
      <BackLink to="/tickets">Tickets</BackLink>
      <PageHeader title={ticket.subject}>
        {nextStatuses.map((status) => (
          <Button
            key={status}
            size="sm"
            onClick={() => statusMutation.mutate(status)}
            disabled={statusMutation.isPending}
          >
            Mark {status}
          </Button>
        ))}
        <StatusBadge status={ticket.status} />
      </PageHeader>
      <FormError error={statusMutation.error} />
      <DetailGrid>
        <Field label="Customer">
          <Link to={`/customers/${ticket.customer_id}`} className="font-mono">
            {ticket.customer_id}
          </Link>
        </Field>
        <Field label="Priority">
          <StatusBadge status={ticket.priority} />
        </Field>
        <Field label="Created">{formatDate(ticket.created_at)}</Field>
        <Field label="Resolved">{formatDate(ticket.resolved_at)}</Field>
      </DetailGrid>

      <h2>Thread</h2>
      {ticket.messages.length === 0 ? (
        <EmptyState>No messages yet.</EmptyState>
      ) : (
        <ul className="flex list-none flex-col gap-3 p-0">
          {ticket.messages.map((m) => (
            <li
              key={m.message_id}
              className="rounded-lg border border-border bg-surface p-4 shadow-sm"
            >
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="font-semibold capitalize text-fg">{m.author}</span>
                <span className="text-subtle">{formatDate(m.created_at)}</span>
              </div>
              <div className="whitespace-pre-wrap text-sm text-fg">{m.body}</div>
            </li>
          ))}
        </ul>
      )}

      {ticket.status !== "closed" && (
        <form
          className="mt-6 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) replyMutation.mutate({ author, body: body.trim() });
          }}
        >
          <h2 className="m-0">Reply</h2>
          <textarea
            className="input"
            placeholder="Write a reply…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={10_000}
            required
          />
          <FormError error={replyMutation.error} />
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input"
              style={{ width: "auto" }}
              value={author}
              onChange={(e) => setAuthor(e.target.value as MessageAuthor)}
            >
              <option value="agent">as agent</option>
              <option value="customer">as customer</option>
              <option value="system">as system</option>
            </select>
            <Button
              type="submit"
              variant="primary"
              loading={replyMutation.isPending}
              disabled={replyMutation.isPending || !body.trim()}
            >
              {replyMutation.isPending ? "Sending…" : "Send reply"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
