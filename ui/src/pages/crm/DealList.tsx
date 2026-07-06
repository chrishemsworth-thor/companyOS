import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { StatusFilter } from "../../components/FilterBar";
import { formatMoney } from "../../lib/format";
import type { Deal, DealStatus, PipelineStage } from "../../api/types";

const STATUSES: DealStatus[] = ["open", "won", "lost"];

export function DealList() {
  const { client } = useAuth();
  const [status, setStatus] = useState("");

  const stagesQuery = useQuery({
    queryKey: ["deals", "stages"],
    queryFn: () => client!.get<{ stages: PipelineStage[] }>("/v1/deals/stages"),
    enabled: !!client,
  });
  const dealsQuery = useQuery({
    queryKey: ["deals", status],
    queryFn: () => client!.get<{ deals: Deal[] }>(`/v1/deals${status ? `?status=${status}` : ""}`),
    enabled: !!client,
  });

  const stageNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of stagesQuery.data?.stages ?? []) map.set(stage.stage_id, stage.name);
    return map;
  }, [stagesQuery.data]);

  return (
    <div>
      <div className="page-header">
        <h1>Deals</h1>
        <StatusFilter value={status} options={STATUSES} onChange={setStatus} />
      </div>
      {(dealsQuery.isLoading || stagesQuery.isLoading) && <LoadingState />}
      {(dealsQuery.error || stagesQuery.error) && (
        <ErrorState error={dealsQuery.error ?? stagesQuery.error} />
      )}
      {dealsQuery.data && (
        <DataTable
          rows={dealsQuery.data.deals}
          rowKey={(r) => r.deal_id}
          rowHref={(r) => `/deals/${r.deal_id}`}
          columns={[
            { header: "Deal", render: (r) => r.title },
            { header: "Customer", render: (r) => r.customer_id },
            { header: "Stage", render: (r) => stageNameById.get(r.stage_id) ?? r.stage_id },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Value", render: (r) => formatMoney(r.value_cents, r.currency), align: "right" },
          ]}
        />
      )}
    </div>
  );
}
