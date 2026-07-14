import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { FormError } from "../../components/FormError";
import { AgentEventFeed } from "../../components/AgentEventFeed";
import { PaymentModal } from "../../components/modals/PaymentModal";
import { ReminderModal } from "../../components/modals/ReminderModal";
import { useApiMutation } from "../../hooks/useApiMutation";
import { formatMoney, formatDate } from "../../lib/format";
import type { InvoiceDetail as InvoiceDetailType } from "../../api/types";

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [reminderModalOpen, setReminderModalOpen] = useState(false);
  const query = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => client!.get<InvoiceDetailType>(`/v1/invoices/${id}`),
    enabled: !!client && !!id,
  });

  const sendMutation = useApiMutation({
    mutationFn: (apiClient, invoiceId: string) => apiClient.post(`/v1/invoices/${invoiceId}/send`),
    invalidates: (invoiceId) => [["invoice", invoiceId], ["invoices"]],
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;
  const invoice = query.data;
  if (!invoice) return null;

  const canPay = invoice.amount_due_cents > 0 && !["draft", "cancelled"].includes(invoice.status);
  const canRemind = ["sent", "overdue", "partially_paid"].includes(invoice.status);

  return (
    <div>
      <BackLink to="/invoices">Invoices</BackLink>
      <PageHeader title={<span className="font-mono">{invoice.invoice_id}</span>}>
        {invoice.status === "draft" && (
          <Button
            variant="primary"
            onClick={() => sendMutation.mutate(invoice.invoice_id)}
            loading={sendMutation.isPending}
          >
            {sendMutation.isPending ? "Sending…" : "Send invoice"}
          </Button>
        )}
        {canRemind && (
          <Button onClick={() => setReminderModalOpen(true)}>Send reminder</Button>
        )}
        {canPay && (
          <Button variant="primary" onClick={() => setPayModalOpen(true)}>
            Record payment
          </Button>
        )}
        <StatusBadge status={invoice.status} />
      </PageHeader>
      <FormError error={sendMutation.error} />
      {payModalOpen && <PaymentModal invoice={invoice} onClose={() => setPayModalOpen(false)} />}
      {reminderModalOpen && (
        <ReminderModal invoiceId={invoice.invoice_id} onClose={() => setReminderModalOpen(false)} />
      )}

      <DetailGrid>
        <Field label="Customer">
          <Link to={`/customers/${invoice.customer_id}`} className="font-mono">
            {invoice.customer_id}
          </Link>
        </Field>
        <Field label="Total">{formatMoney(invoice.total_cents, invoice.currency)}</Field>
        <Field label="Amount due">{formatMoney(invoice.amount_due_cents, invoice.currency)}</Field>
        <Field label="Due date">{invoice.due_date}</Field>
        <Field label="Issued">{formatDate(invoice.issued_at)}</Field>
        <Field label="Sent">{formatDate(invoice.sent_at)}</Field>
        <Field label="Paid">{formatDate(invoice.paid_at)}</Field>
      </DetailGrid>

      <h2>Line items</h2>
      <DataTable
        rows={invoice.lines}
        rowKey={(line) => String(line.line_no)}
        columns={[
          { header: "#", render: (line) => line.line_no },
          { header: "Description", render: (line) => line.description },
          { header: "Qty", render: (line) => line.quantity, align: "right" },
          {
            header: "Unit price",
            render: (line) => formatMoney(line.unit_cents, invoice.currency),
            align: "right",
          },
          {
            header: "Line total",
            render: (line) => formatMoney(line.unit_cents * line.quantity, invoice.currency),
            align: "right",
          },
        ]}
      />

      <h2>Agent activity</h2>
      <AgentEventFeed invoiceId={invoice.invoice_id} />
    </div>
  );
}
