import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { StatusFilter } from "../../components/FilterBar";
import { InvoiceCreateModal } from "../../components/modals/InvoiceCreateModal";
import { formatMoney, formatDate } from "../../lib/format";
import type { Invoice, InvoiceStatus } from "../../api/types";

const STATUSES: InvoiceStatus[] = ["draft", "sent", "overdue", "partially_paid", "paid", "cancelled"];

export function InvoiceList() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["invoices", status],
    queryFn: () =>
      client!.get<{ invoices: Invoice[] }>(`/v1/invoices${status ? `?status=${status}` : ""}`),
    enabled: !!client,
  });

  return (
    <div>
      <div className="page-header">
        <h1>Invoices</h1>
        <div className="action-bar">
          <StatusFilter value={status} options={STATUSES} onChange={setStatus} />
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            New invoice
          </button>
        </div>
      </div>
      {creating && (
        <InvoiceCreateModal
          onClose={() => setCreating(false)}
          onCreated={(invoice) => navigate(`/invoices/${invoice.invoice_id}`)}
        />
      )}
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.invoices}
          rowKey={(r) => r.invoice_id}
          rowHref={(r) => `/invoices/${r.invoice_id}`}
          columns={[
            { header: "Invoice", render: (r) => r.invoice_id },
            { header: "Customer", render: (r) => r.customer_id },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Total", render: (r) => formatMoney(r.total_cents, r.currency), align: "right" },
            {
              header: "Amount due",
              render: (r) => formatMoney(r.amount_due_cents, r.currency),
              align: "right",
            },
            { header: "Due date", render: (r) => r.due_date },
            { header: "Sent", render: (r) => formatDate(r.sent_at) },
          ]}
        />
      )}
    </div>
  );
}
