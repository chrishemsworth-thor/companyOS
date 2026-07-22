import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { StatusBadge } from "../../components/StatusBadge";
import { LeadFormModal } from "../../components/modals/LeadFormModal";
import { LeadConvertModal } from "../../components/modals/LeadConvertModal";
import { useApiMutation } from "../../hooks/useApiMutation";
import { formatDate } from "../../lib/format";
import type { Lead } from "../../api/types";

type OpenModal = "edit" | "convert" | null;

export function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const navigate = useNavigate();
  const [openModal, setOpenModal] = useState<OpenModal>(null);

  const leadQuery = useQuery({
    queryKey: ["lead", id],
    queryFn: () => client!.get<Lead>(`/v1/leads/${id}`),
    enabled: !!client && !!id,
  });

  const enrichMutation = useApiMutation({
    mutationFn: (client, _vars: void) =>
      client.post<{ lead: Lead; enriched_fields: string[] }>(`/v1/leads/${id}/enrich`, {}),
    invalidates: () => [["leads"], ["lead", id]],
    successMessage: (result) =>
      result.enriched_fields.length > 0
        ? `Enrichment filled: ${result.enriched_fields.join(", ")}`
        : "No new data found",
  });

  const loseMutation = useApiMutation({
    mutationFn: (client, _vars: void) => client.patch<Lead>(`/v1/leads/${id}`, { status: "lost" }),
    invalidates: () => [["leads"], ["lead", id]],
    successMessage: "Lead marked lost",
  });

  if (leadQuery.isLoading) return <LoadingState />;
  if (leadQuery.error) return <ErrorState error={leadQuery.error} />;
  const lead = leadQuery.data;
  if (!lead) return null;

  const workable = lead.status === "new" || lead.status === "qualified";

  return (
    <div>
      <BackLink to="/leads">Leads</BackLink>
      <PageHeader title={lead.name}>
        {workable && <Button onClick={() => setOpenModal("edit")}>Edit</Button>}
        {workable && (
          <Button onClick={() => enrichMutation.mutate()} loading={enrichMutation.isPending}>
            {enrichMutation.isPending ? "Enriching…" : "Enrich"}
          </Button>
        )}
        {workable && (
          <Button variant="primary" onClick={() => setOpenModal("convert")}>
            Convert
          </Button>
        )}
        {workable && (
          <Button onClick={() => loseMutation.mutate()} loading={loseMutation.isPending}>
            Mark lost
          </Button>
        )}
      </PageHeader>

      {openModal === "edit" && (
        <LeadFormModal existing={lead} onClose={() => setOpenModal(null)} />
      )}
      {openModal === "convert" && (
        <LeadConvertModal
          lead={lead}
          onClose={() => setOpenModal(null)}
          onConverted={(result) => navigate(`/customers/${result.customer.customer_id}`)}
        />
      )}

      <DetailGrid>
        <Field label="Lead id">
          <span className="font-mono">{lead.lead_id}</span>
        </Field>
        <Field label="Status">
          <StatusBadge status={lead.status} />
        </Field>
        <Field label="Company">{lead.company ?? "—"}</Field>
        <Field label="Title">{lead.title ?? "—"}</Field>
        <Field label="Email">{lead.email ?? "—"}</Field>
        <Field label="Phone">{lead.phone ?? "—"}</Field>
        <Field label="Source">{lead.source}</Field>
        <Field label="Created">{formatDate(lead.created_at)}</Field>
        <Field label="Last enriched">
          {lead.enriched_at ? formatDate(lead.enriched_at) : "Never"}
        </Field>
        {lead.converted_customer_id && (
          <Field label="Converted to customer">
            <Link to={`/customers/${lead.converted_customer_id}`} className="font-mono">
              {lead.converted_customer_id}
            </Link>
          </Field>
        )}
        {lead.converted_deal_id && (
          <Field label="Converted to deal">
            <Link to={`/deals/${lead.converted_deal_id}`} className="font-mono">
              {lead.converted_deal_id}
            </Link>
          </Field>
        )}
      </DetailGrid>

      <h2>Notes</h2>
      <p className="text-sm text-muted whitespace-pre-wrap">{lead.notes ?? "—"}</p>
    </div>
  );
}
