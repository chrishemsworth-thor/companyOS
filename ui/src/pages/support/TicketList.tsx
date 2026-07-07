import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { TicketCreateModal } from "../../components/modals/TicketCreateModal";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { StatusFilter } from "../../components/FilterBar";
import { formatDate } from "../../lib/format";
import type { Ticket, TicketStatus } from "../../api/types";

const STATUSES: TicketStatus[] = ["open", "pending", "resolved", "closed"];

export function TicketList() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["tickets", status],
    queryFn: () =>
      client!.get<{ tickets: Ticket[] }>(`/v1/tickets${status ? `?status=${status}` : ""}`),
    enabled: !!client,
  });

  return (
    <div>
      <div className="page-header">
        <h1>Tickets</h1>
        <div className="action-bar">
          <StatusFilter value={status} options={STATUSES} onChange={setStatus} />
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            New ticket
          </button>
        </div>
      </div>
      {creating && (
        <TicketCreateModal
          onClose={() => setCreating(false)}
          onCreated={(ticket) => navigate(`/tickets/${ticket.ticket_id}`)}
        />
      )}
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.tickets}
          rowKey={(r) => r.ticket_id}
          rowHref={(r) => `/tickets/${r.ticket_id}`}
          columns={[
            { header: "Subject", render: (r) => r.subject },
            { header: "Customer", render: (r) => r.customer_id },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Priority", render: (r) => <StatusBadge status={r.priority} /> },
            { header: "Updated", render: (r) => formatDate(r.updated_at) },
          ]}
        />
      )}
    </div>
  );
}
