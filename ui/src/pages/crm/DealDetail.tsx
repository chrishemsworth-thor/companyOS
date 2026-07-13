import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { FormError } from "../../components/FormError";
import { ActivityLogModal } from "../../components/modals/ActivityLogModal";
import { formatMoney, formatDate } from "../../lib/format";
import type { Deal, PipelineStage } from "../../api/types";

export function DealDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [loggingActivity, setLoggingActivity] = useState(false);

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

  // Stage moves are optimistic: the change is visible immediately and rolled
  // back on error; won/lost status still comes from the server refetch.
  const stageMutation = useMutation({
    mutationFn: (stage_id: string) => client!.post<Deal>(`/v1/deals/${id}/stage`, { stage_id }),
    onMutate: async (stage_id) => {
      await queryClient.cancelQueries({ queryKey: ["deal", id] });
      const previous = queryClient.getQueryData<Deal>(["deal", id]);
      if (previous) queryClient.setQueryData<Deal>(["deal", id], { ...previous, stage_id });
      return { previous };
    },
    onError: (_err, _stageId, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["deal", id], ctx.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["deal", id] });
      void queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });

  if (dealQuery.isLoading) return <LoadingState />;
  if (dealQuery.error) return <ErrorState error={dealQuery.error} />;
  const deal = dealQuery.data;
  if (!deal) return null;
  const stages = stagesQuery.data?.stages ?? [];

  return (
    <div>
      <BackLink to="/deals">Deals</BackLink>
      <PageHeader title={deal.title}>
        <Button onClick={() => setLoggingActivity(true)}>Log activity</Button>
        {deal.status === "open" && stages.length > 0 && (
          <select
            className="input"
            style={{ width: "auto" }}
            value={deal.stage_id}
            onChange={(e) => stageMutation.mutate(e.target.value)}
            disabled={stageMutation.isPending}
          >
            {stages.map((s) => (
              <option key={s.stage_id} value={s.stage_id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <StatusBadge status={deal.status} />
      </PageHeader>
      <FormError error={stageMutation.error} />
      {loggingActivity && (
        <ActivityLogModal
          customerId={deal.customer_id}
          dealId={deal.deal_id}
          onClose={() => setLoggingActivity(false)}
        />
      )}
      <DetailGrid>
        <Field label="Customer">
          <Link to={`/customers/${deal.customer_id}`} className="font-mono">
            {deal.customer_id}
          </Link>
        </Field>
        <Field label="Stage">
          {stages.find((s) => s.stage_id === deal.stage_id)?.name ?? deal.stage_id}
        </Field>
        <Field label="Value">{formatMoney(deal.value_cents, deal.currency)}</Field>
        <Field label="Created">{formatDate(deal.created_at)}</Field>
        <Field label="Updated">{formatDate(deal.updated_at)}</Field>
      </DetailGrid>
    </div>
  );
}
