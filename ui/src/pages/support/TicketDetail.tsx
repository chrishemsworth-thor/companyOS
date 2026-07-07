import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
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
      <Link to="/tickets" className="back-link">
        ← Tickets
      </Link>
      <div className="page-header">
        <h1>{ticket.subject}</h1>
        <div className="action-bar">
          {nextStatuses.map((status) => (
            <button
              key={status}
              className="btn btn-sm"
              onClick={() => statusMutation.mutate(status)}
              disabled={statusMutation.isPending}
            >
              Mark {status}
            </button>
          ))}
          <StatusBadge status={ticket.status} />
        </div>
      </div>
      <FormError error={statusMutation.error} />
      <div className="detail-grid">
        <Field label="Customer">
          <Link to={`/customers/${ticket.customer_id}`}>{ticket.customer_id}</Link>
        </Field>
        <Field label="Priority">
          <StatusBadge status={ticket.priority} />
        </Field>
        <Field label="Created">{formatDate(ticket.created_at)}</Field>
        <Field label="Resolved">{formatDate(ticket.resolved_at)}</Field>
      </div>

      <h2>Thread</h2>
      {ticket.messages.length === 0 && <div className="empty-state">No messages yet.</div>}
      <ul className="thread">
        {ticket.messages.map((m) => (
          <li key={m.message_id} className={`thread-message author-${m.author}`}>
            <div className="thread-meta">
              <span className="thread-author">{m.author}</span>
              <span className="thread-time">{formatDate(m.created_at)}</span>
            </div>
            <div className="thread-body">{m.body}</div>
          </li>
        ))}
      </ul>

      {ticket.status !== "closed" && (
        <form
          className="reply-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) replyMutation.mutate({ author, body: body.trim() });
          }}
        >
          <h2>Reply</h2>
          <textarea
            className="input"
            placeholder="Write a reply…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={10_000}
            required
          />
          <FormError error={replyMutation.error} />
          <div className="action-bar">
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
            <button
              type="submit"
              className="btn btn-primary"
              disabled={replyMutation.isPending || !body.trim()}
            >
              {replyMutation.isPending ? "Sending…" : "Send reply"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
