import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
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
      <Link to="/invoices" className="back-link">
        ← Invoices
      </Link>
      <div className="page-header">
        <h1>{invoice.invoice_id}</h1>
        <div className="action-bar">
          {invoice.status === "draft" && (
            <button
              className="btn btn-primary"
              onClick={() => sendMutation.mutate(invoice.invoice_id)}
              disabled={sendMutation.isPending}
            >
              {sendMutation.isPending ? "Sending…" : "Send invoice"}
            </button>
          )}
          {canRemind && (
            <button className="btn" onClick={() => setReminderModalOpen(true)}>
              Send reminder
            </button>
          )}
          {canPay && (
            <button className="btn btn-primary" onClick={() => setPayModalOpen(true)}>
              Record payment
            </button>
          )}
          <StatusBadge status={invoice.status} />
        </div>
      </div>
      <FormError error={sendMutation.error} />
      {payModalOpen && <PaymentModal invoice={invoice} onClose={() => setPayModalOpen(false)} />}
      {reminderModalOpen && (
        <ReminderModal invoiceId={invoice.invoice_id} onClose={() => setReminderModalOpen(false)} />
      )}

      <div className="detail-grid">
        <Field label="Customer">
          <Link to={`/customers/${invoice.customer_id}`}>{invoice.customer_id}</Link>
        </Field>
        <Field label="Total">{formatMoney(invoice.total_cents, invoice.currency)}</Field>
        <Field label="Amount due">{formatMoney(invoice.amount_due_cents, invoice.currency)}</Field>
        <Field label="Due date">{invoice.due_date}</Field>
        <Field label="Issued">{formatDate(invoice.issued_at)}</Field>
        <Field label="Sent">{formatDate(invoice.sent_at)}</Field>
        <Field label="Paid">{formatDate(invoice.paid_at)}</Field>
      </div>

      <h2>Line items</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th style={{ textAlign: "right" }}>Qty</th>
            <th style={{ textAlign: "right" }}>Unit price</th>
            <th style={{ textAlign: "right" }}>Line total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.line_no}>
              <td>{line.line_no}</td>
              <td>{line.description}</td>
              <td style={{ textAlign: "right" }}>{line.quantity}</td>
              <td style={{ textAlign: "right" }}>{formatMoney(line.unit_cents, invoice.currency)}</td>
              <td style={{ textAlign: "right" }}>
                {formatMoney(line.unit_cents * line.quantity, invoice.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Agent activity</h2>
      <AgentEventFeed invoiceId={invoice.invoice_id} />
    </div>
  );
}
