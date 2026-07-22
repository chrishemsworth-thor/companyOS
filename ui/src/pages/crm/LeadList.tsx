import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { StatusBadge } from "../../components/StatusBadge";
import { LeadFormModal } from "../../components/modals/LeadFormModal";
import type { Lead } from "../../api/types";

export function LeadList() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["leads"],
    queryFn: () => client!.get<{ leads: Lead[] }>("/v1/leads"),
    enabled: !!client,
  });

  return (
    <div>
      <PageHeader title="Leads">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New lead
        </Button>
      </PageHeader>
      {creating && (
        <LeadFormModal
          onClose={() => setCreating(false)}
          onSaved={(lead) => navigate(`/leads/${lead.lead_id}`)}
        />
      )}
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.leads}
          rowKey={(r) => r.lead_id}
          rowHref={(r) => `/leads/${r.lead_id}`}
          emptyLabel="No leads yet."
          columns={[
            { header: "Name", render: (r) => r.name },
            { header: "Company", render: (r) => r.company ?? "—" },
            { header: "Email", render: (r) => r.email ?? "—" },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Source", render: (r) => r.source },
          ]}
        />
      )}
    </div>
  );
}
