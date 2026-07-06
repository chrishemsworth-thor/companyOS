import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { Field } from "../../components/Field";
import { formatMoney, formatDate } from "../../lib/format";
import type { Customer, PaymentHistoryEntry, Activity } from "../../api/types";

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();

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

  if (customerQuery.isLoading) return <LoadingState />;
  if (customerQuery.error) return <ErrorState error={customerQuery.error} />;
  const customer = customerQuery.data;
  if (!customer) return null;

  return (
    <div>
      <Link to="/customers" className="back-link">
        ← Customers
      </Link>
      <h1>{customer.name}</h1>

      <div className="detail-grid">
        <Field label="Customer id">{customer.customer_id}</Field>
        <Field label="Email">{customer.email ?? "—"}</Field>
        <Field label="Phone">{customer.phone ?? "—"}</Field>
      </div>

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
