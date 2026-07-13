import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState, EmptyState } from "../../components/AsyncState";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { CustomerFormModal } from "../../components/modals/CustomerFormModal";
import { ActivityLogModal } from "../../components/modals/ActivityLogModal";
import { DealCreateModal } from "../../components/modals/DealCreateModal";
import { InvoiceCreateModal } from "../../components/modals/InvoiceCreateModal";
import { TicketCreateModal } from "../../components/modals/TicketCreateModal";
import { AgentEventFeed } from "../../components/AgentEventFeed";
import { StatusBadge } from "../../components/StatusBadge";
import { formatMoney, formatDate } from "../../lib/format";
import type { AgentSnapshot, Customer, PaymentHistoryEntry, Activity } from "../../api/types";

type OpenModal = "edit" | "activity" | "deal" | "invoice" | "ticket" | null;

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const navigate = useNavigate();
  const [openModal, setOpenModal] = useState<OpenModal>(null);

  const customerQuery = useQuery({
    queryKey: ["customer", id],
    queryFn: () => client!.get<Customer>(`/v1/customers/${id}`),
    enabled: !!client && !!id,
  });
  const historyQuery = useQuery({
    queryKey: ["customer", id, "payment-history"],
    queryFn: () =>
      client!.get<{ payments: PaymentHistoryEntry[] }>(`/v1/customers/${id}/payment-history`),
    enabled: !!client && !!id,
  });
  const activitiesQuery = useQuery({
    queryKey: ["customer", id, "activities"],
    queryFn: () => client!.get<{ activities: Activity[] }>(`/v1/customers/${id}/activities`),
    enabled: !!client && !!id,
  });
  const agentQuery = useQuery({
    queryKey: ["customer", id, "agent"],
    queryFn: () => client!.get<{ agent_state: AgentSnapshot | null }>(`/v1/customers/${id}/agent`),
    enabled: !!client && !!id,
  });

  if (customerQuery.isLoading) return <LoadingState />;
  if (customerQuery.error) return <ErrorState error={customerQuery.error} />;
  const customer = customerQuery.data;
  if (!customer) return null;

  return (
    <div>
      <BackLink to="/customers">Customers</BackLink>
      <PageHeader title={customer.name}>
        <Button onClick={() => setOpenModal("edit")}>Edit</Button>
        <Button onClick={() => setOpenModal("activity")}>Log activity</Button>
        <Button onClick={() => setOpenModal("deal")}>New deal</Button>
        <Button onClick={() => setOpenModal("invoice")}>New invoice</Button>
        <Button onClick={() => setOpenModal("ticket")}>New ticket</Button>
      </PageHeader>

      {openModal === "edit" && (
        <CustomerFormModal existing={customer} onClose={() => setOpenModal(null)} />
      )}
      {openModal === "activity" && (
        <ActivityLogModal customerId={customer.customer_id} onClose={() => setOpenModal(null)} />
      )}
      {openModal === "deal" && (
        <DealCreateModal
          defaultCustomerId={customer.customer_id}
          onClose={() => setOpenModal(null)}
          onCreated={(deal) => navigate(`/deals/${deal.deal_id}`)}
        />
      )}
      {openModal === "invoice" && (
        <InvoiceCreateModal
          defaultCustomerId={customer.customer_id}
          onClose={() => setOpenModal(null)}
          onCreated={(invoice) => navigate(`/invoices/${invoice.invoice_id}`)}
        />
      )}
      {openModal === "ticket" && (
        <TicketCreateModal
          defaultCustomerId={customer.customer_id}
          onClose={() => setOpenModal(null)}
          onCreated={(ticket) => navigate(`/tickets/${ticket.ticket_id}`)}
        />
      )}

      <DetailGrid>
        <Field label="Customer id">
          <span className="font-mono">{customer.customer_id}</span>
        </Field>
        <Field label="Email">{customer.email ?? "—"}</Field>
        <Field label="Phone">{customer.phone ?? "—"}</Field>
      </DetailGrid>

      <h2>Collections agent</h2>
      {agentQuery.data?.agent_state ? (
        <DetailGrid>
          <Field label="Risk score">{agentQuery.data.agent_state.risk_score}/100</Field>
          <Field label="Escalation">
            <StatusBadge status={agentQuery.data.agent_state.escalation_stage} />
          </Field>
          <Field label="Last contact">{formatDate(agentQuery.data.agent_state.last_contact)}</Field>
          <Field label="Reminders sent">{agentQuery.data.agent_state.reminder_history.length}</Field>
          <Field label="Open overdue invoices">
            {agentQuery.data.agent_state.open_overdue_invoices.length === 0
              ? "None"
              : agentQuery.data.agent_state.open_overdue_invoices.map((invoiceId) => (
                  <div key={invoiceId}>
                    <Link to={`/invoices/${invoiceId}`} className="font-mono">
                      {invoiceId}
                    </Link>
                  </div>
                ))}
          </Field>
        </DetailGrid>
      ) : (
        <EmptyState>The collections agent hasn't engaged this customer.</EmptyState>
      )}
      <h2>Agent activity</h2>
      <AgentEventFeed customerId={id} showCustomer={false} />

      <h2>Payment history</h2>
      {historyQuery.isLoading && <LoadingState />}
      {historyQuery.data && (
        <DataTable
          rows={historyQuery.data.payments}
          rowKey={(p) => `${p.payment_id}-${p.invoice_id}`}
          emptyLabel="No payments yet."
          columns={[
            { header: "Payment", render: (p) => <span className="font-mono text-[0.85em]">{p.payment_id}</span> },
            {
              header: "Invoice",
              render: (p) => (
                <Link to={`/invoices/${p.invoice_id}`} className="font-mono text-[0.85em]">
                  {p.invoice_id}
                </Link>
              ),
            },
            { header: "Applied", render: (p) => formatMoney(p.applied_cents, p.currency), align: "right" },
            { header: "Received", render: (p) => formatDate(p.received_at) },
          ]}
        />
      )}

      <h2>Activity</h2>
      {activitiesQuery.isLoading && <LoadingState />}
      {activitiesQuery.data && activitiesQuery.data.activities.length === 0 && (
        <EmptyState>No activity logged yet.</EmptyState>
      )}
      {activitiesQuery.data && activitiesQuery.data.activities.length > 0 && (
        <ul className="flex list-none flex-col gap-2 p-0">
          {activitiesQuery.data.activities.map((a) => (
            <li
              key={a.activity_id}
              className="flex items-baseline gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-sm"
            >
              <span className="shrink-0 font-semibold capitalize">{a.kind.replace("_", " ")}</span>
              <span className="flex-1 text-muted">{a.body ?? "—"}</span>
              <span className="shrink-0 text-xs text-subtle">{formatDate(a.occurred_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
