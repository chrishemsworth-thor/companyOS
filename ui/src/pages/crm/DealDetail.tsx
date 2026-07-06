import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
import { formatMoney, formatDate } from "../../lib/format";
import type { Deal, PipelineStage } from "../../api/types";

export function DealDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();

  const dealQuery = useQuery({
    queryKey: ["deal", id],
    queryFn: () => client!.get<Deal>(`/v1/deals/${id}`),
    enabled: !!client && !!id,
  });
  const stagesQuery = useQuery({
    queryKey: ["deals", "stages"],
    queryFn: () => client!.get<{ stages: PipelineStage[] }>("/v1/deals/stages"),
    enabled: !!client,
  });

  if (dealQuery.isLoading) return <LoadingState />;
  if (dealQuery.error) return <ErrorState error={dealQuery.error} />;
  const deal = dealQuery.data;
  if (!deal) return null;
  const stageName = stagesQuery.data?.stages.find((s) => s.stage_id === deal.stage_id)?.name;

  return (
    <div>
      <Link to="/deals" className="back-link">
        ← Deals
      </Link>
      <div className="page-header">
        <h1>{deal.title}</h1>
        <StatusBadge status={deal.status} />
      </div>
      <div className="detail-grid">
        <Field label="Customer">
          <Link to={`/customers/${deal.customer_id}`}>{deal.customer_id}</Link>
        </Field>
        <Field label="Stage">{stageName ?? deal.stage_id}</Field>
        <Field label="Value">{formatMoney(deal.value_cents, deal.currency)}</Field>
        <Field label="Created">{formatDate(deal.created_at)}</Field>
        <Field label="Updated">{formatDate(deal.updated_at)}</Field>
      </div>
    </div>
  );
}
