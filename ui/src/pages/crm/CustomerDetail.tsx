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
import { CanWrite } from "../../components/CanWrite";
import { DataTable } from "../../components/DataTable";
import { CustomerFormModal } from "../../components/modals/CustomerFormModal";
import { ContactFormModal } from "../../components/modals/ContactFormModal";
import { ActivityLogModal } from "../../components/modals/ActivityLogModal";
import { DealCreateModal } from "../../components/modals/DealCreateModal";
import { InvoiceCreateModal } from "../../components/modals/InvoiceCreateModal";
import { TicketCreateModal } from "../../components/modals/TicketCreateModal";
import { AgentEventFeed } from "../../components/AgentEventFeed";
import { StatusBadge } from "../../components/StatusBadge";
import { Badge } from "../../components/Badge";
import { HealthBadge } from "../../components/HealthBadge";
import { formatMoney, formatDate } from "../../lib/format";
import {
  CONTACT_ROLE_LABELS,
  type AgentSnapshot,
  type Contact,
  type Customer,
  type PaymentHistoryEntry,
  type Activity,
} from "../../api/types";

type OpenModal = "edit" | "contact" | "activity" | "deal" | "invoice" | "ticket" | null;

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const navigate = useNavigate();
  const [openModal, setOpenModal] = useState<OpenModal>(null);
  // Set alongside openModal === "contact" to edit instead of create.
  const [editingContact, setEditingContact] = useState<Contact | null>(null);

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
  const contactsQuery = useQuery({
    queryKey: ["contacts", id],
    queryFn: () => client!.get<{ contacts: Contact[] }>(`/v1/customers/${id}/contacts`),
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
        <CanWrite module="crm">
          <Button onClick={() => setOpenModal("edit")}>Edit</Button>
          <Button onClick={() => setOpenModal("activity")}>Log activity</Button>
          <Button onClick={() => setOpenModal("deal")}>New deal</Button>
        </CanWrite>
        {/* Cross-module actions need the *target* module's write capability:
            support raises tickets on a customer but cannot invoice one. */}
        <CanWrite module="finance">
          <Button onClick={() => setOpenModal("invoice")}>New invoice</Button>
        </CanWrite>
        <CanWrite module="support">
          <Button onClick={() => setOpenModal("ticket")}>New ticket</Button>
        </CanWrite>
      </PageHeader>

      {openModal === "edit" && (
        <CustomerFormModal existing={customer} onClose={() => setOpenModal(null)} />
      )}
      {openModal === "contact" && (
        <ContactFormModal
          customerId={customer.customer_id}
          existing={editingContact ?? undefined}
          onClose={() => {
            setOpenModal(null);
            setEditingContact(null);
          }}
        />
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
        <Field label="Industry">{customer.industry ?? "—"}</Field>
        <Field label="Website">{customer.website ?? "—"}</Field>
        <Field label="Payment terms">
          {customer.payment_terms_days === null
            ? "Tenant default"
            : `${customer.payment_terms_days} days`}
        </Field>
        <Field label="Preferred channel">{customer.preferred_channel ?? "—"}</Field>
        <Field label="Registration no.">{customer.reg_no ?? "—"}</Field>
        <Field label="Tax / SST no.">{customer.tax_no ?? "—"}</Field>
      </DetailGrid>

      {/* PRD-003: "a reasons panel on the detail page". The reasons are the
          product here — the band alone is not actionable. */}
      {customer.health && (
        <section className="mt-4 rounded-lg border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-base">Account health</h2>
            <HealthBadge band={customer.health.band} />
          </div>
          <ul className="mt-2 flex list-none flex-col gap-1 p-0 text-sm">
            {customer.health.reasons.map((reason) => (
              <li key={reason.code} className="flex items-baseline gap-2">
                <span className="text-muted">{reason.detail}</span>
                {reason.invoice_ids?.map((invoiceId) => (
                  <Link key={invoiceId} to={`/invoices/${invoiceId}`} className="font-mono text-xs">
                    {invoiceId}
                  </Link>
                ))}
              </li>
            ))}
          </ul>
          {customer.credit?.limit_cents !== null && customer.credit !== undefined && (
            <p className="mt-2 text-sm text-muted">
              Credit limit {formatMoney(customer.credit.limit_cents ?? 0, "MYR")} ·{" "}
              {formatMoney(customer.credit.outstanding_ar_cents, "MYR")} outstanding ·{" "}
              {formatMoney(customer.credit.available_cents ?? 0, "MYR")} available
              {(customer.credit.available_cents ?? 0) < 0 && " — over limit"}
            </p>
          )}
        </section>
      )}

      {customer.notes && (
        <section className="mt-4">
          <h2>Notes</h2>
          <p className="whitespace-pre-wrap text-sm text-muted">{customer.notes}</p>
        </section>
      )}

      <div className="flex items-center justify-between">
        <h2>Contacts</h2>
        <Button
          onClick={() => {
            setEditingContact(null);
            setOpenModal("contact");
          }}
        >
          Add contact
        </Button>
      </div>
      {contactsQuery.isLoading && <LoadingState />}
      {contactsQuery.data && (
        <DataTable
          rows={contactsQuery.data.contacts}
          rowKey={(c) => c.contact_id}
          emptyLabel="No contacts yet."
          columns={[
            { header: "Name", render: (c) => c.name },
            {
              // PRD-003: role badges in the contact list. The primary badge
              // comes out of the same list rather than being rendered from
              // `is_primary` separately — one fact, one badge.
              header: "Roles",
              render: (c) => (
                <span className="flex flex-wrap gap-1">
                  {c.roles.length === 0
                    ? "—"
                    : c.roles.map((role) => (
                        // `primary` is the one role with a tone: it is the
                        // fallback every unmatched lookup lands on, so it is
                        // worth spotting at a glance.
                        <Badge key={role} tone={role === "primary" ? "good" : "neutral"}>
                          {CONTACT_ROLE_LABELS[role]}
                        </Badge>
                      ))}
                </span>
              ),
            },
            { header: "Title", render: (c) => c.title ?? "—" },
            { header: "Department", render: (c) => c.department ?? "—" },
            { header: "Email", render: (c) => c.email ?? "—" },
            { header: "Phone", render: (c) => c.phone ?? "—" },
            {
              header: "",
              render: (c) => (
                <Button
                  onClick={() => {
                    setEditingContact(c);
                    setOpenModal("contact");
                  }}
                >
                  Edit
                </Button>
              ),
              align: "right",
            },
          ]}
        />
      )}

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
