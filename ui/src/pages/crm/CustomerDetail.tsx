import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { Field } from "../../components/Field";
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
      <Link to="/customers" className="back-link">
        ← Customers
      </Link>
      <div className="page-header">
        <h1>{customer.name}</h1>
        <div className="action-bar">
          <button className="btn" onClick={() => setOpenModal("edit")}>
            Edit
          </button>
          <button className="btn" onClick={() => setOpenModal("activity")}>
            Log activity
          </button>
          <button className="btn" onClick={() => setOpenModal("deal")}>
            New deal
          </button>
          <button className="btn" onClick={() => setOpenModal("invoice")}>
            New invoice
          </button>
          <button className="btn" onClick={() => setOpenModal("ticket")}>
            New ticket
          </button>
        </div>
      </div>

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

      <div className="detail-grid">
        <Field label="Customer id">{customer.customer_id}</Field>
        <Field label="Email">{customer.email ?? "—"}</Field>
        <Field label="Phone">{customer.phone ?? "—"}</Field>
      </div>

      <h2>Collections agent</h2>
      {agentQuery.data?.agent_state ? (
        <div className="detail-grid">
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
                    <Link to={`/invoices/${invoiceId}`}>{invoiceId}</Link>
                  </div>
                ))}
          </Field>
        </div>
      ) : (
        <div className="empty-state">The collections agent hasn't engaged this customer.</div>
      )}
      <h2>Agent activity</h2>
      <AgentEventFeed customerId={id} showCustomer={false} />

      <h2>Payment history</h2>
      {historyQuery.isLoading && <LoadingState />}
      {historyQuery.data && historyQuery.data.payments.length === 0 && (
        <div className="empty-state">No payments yet.</div>
      )}
      {historyQuery.data && historyQuery.data.payments.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Payment</th>
              <th>Invoice</th>
              <th style={{ textAlign: "right" }}>Applied</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {historyQuery.data.payments.map((p) => (
              <tr key={`${p.payment_id}-${p.invoice_id}`}>
                <td>{p.payment_id}</td>
                <td>
                  <Link to={`/invoices/${p.invoice_id}`}>{p.invoice_id}</Link>
                </td>
                <td style={{ textAlign: "right" }}>{formatMoney(p.applied_cents, p.currency)}</td>
                <td>{formatDate(p.received_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Activity</h2>
      {activitiesQuery.isLoading && <LoadingState />}
      {activitiesQuery.data && activitiesQuery.data.activities.length === 0 && (
        <div className="empty-state">No activity logged yet.</div>
      )}
      {activitiesQuery.data && activitiesQuery.data.activities.length > 0 && (
        <ul className="activity-feed">
          {activitiesQuery.data.activities.map((a) => (
            <li key={a.activity_id}>
              <span className="activity-kind">{a.kind.replace("_", " ")}</span>
              <span className="activity-body">{a.body ?? "—"}</span>
              <span className="activity-time">{formatDate(a.occurred_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
