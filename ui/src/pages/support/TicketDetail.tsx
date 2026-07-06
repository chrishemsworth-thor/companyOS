import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
import { formatDate } from "../../lib/format";
import type { TicketDetail as TicketDetailType } from "../../api/types";

export function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => client!.get<TicketDetailType>(`/v1/tickets/${id}`),
    enabled: !!client && !!id,
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;
  const ticket = query.data;
  if (!ticket) return null;

  return (
    <div>
      <Link to="/tickets" className="back-link">
        ← Tickets
      </Link>
      <div className="page-header">
        <h1>{ticket.subject}</h1>
        <StatusBadge status={ticket.status} />
      </div>
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
    </div>
  );
}
