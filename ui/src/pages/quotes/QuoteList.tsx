import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { StatusFilter } from "../../components/FilterBar";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { QuoteCreateModal } from "../../components/modals/QuoteCreateModal";
import { formatMoney, formatDate } from "../../lib/format";
import type { Quote, QuoteStatus } from "../../api/types";

const STATUSES: QuoteStatus[] = ["draft", "sent", "accepted", "rejected", "expired", "converted"];

export function QuoteList() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["quotes", status],
    queryFn: () => client!.get<{ quotes: Quote[] }>(`/v1/quotes${status ? `?status=${status}` : ""}`),
    enabled: !!client,
  });

  return (
    <div>
      <PageHeader title="Quotes">
        <StatusFilter value={status} options={STATUSES} onChange={setStatus} />
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New quote
        </Button>
      </PageHeader>
      {creating && (
        <QuoteCreateModal
          onClose={() => setCreating(false)}
          onCreated={(quote) => navigate(`/quotes/${quote.quote_id}`)}
        />
      )}
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.quotes}
          rowKey={(r) => r.quote_id}
          rowHref={(r) => `/quotes/${r.quote_id}`}
          emptyLabel="No quotes yet."
          columns={[
            { header: "Quote", render: (r) => <span className="font-mono text-[0.85em]">{r.quote_number}</span> },
            { header: "Customer", render: (r) => <span className="font-mono text-[0.85em]">{r.customer_id}</span> },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Total", render: (r) => formatMoney(r.grand_total_cents, r.currency), align: "right" },
            { header: "Issued", render: (r) => r.issue_date },
            { header: "Valid until", render: (r) => r.expiry_date ?? "—" },
            { header: "Sent", render: (r) => formatDate(r.sent_at) },
          ]}
        />
      )}
    </div>
  );
}
