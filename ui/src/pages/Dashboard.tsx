import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState } from "../components/AsyncState";
import { formatMoney } from "../lib/format";

interface CurrencyBucket {
  currency: string;
  count: number;
  cents: number;
}
interface Summary {
  overdue_invoices: { count: number; by_currency: CurrencyBucket[] };
  open_deals: { count: number; by_currency: CurrencyBucket[] };
  open_tickets: { count: number; by_priority: Record<string, number> };
  active_issues: { count: number; by_status: Record<string, number> };
}
interface ArAging {
  buckets: { bucket: string; count: number; cents: number }[];
}

const AGING_LABELS: Record<string, string> = {
  current: "Not yet due",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "60+": "60+ days",
};

export function Dashboard() {
  const { client } = useAuth();

  const summary = useQuery({
    queryKey: ["insights", "summary"],
    queryFn: () => client!.get<Summary>("/v1/insights/summary"),
    enabled: !!client,
  });
  const aging = useQuery({
    queryKey: ["insights", "ar-aging"],
    queryFn: () => client!.get<ArAging>("/v1/insights/ar-aging"),
    enabled: !!client,
  });

  if (summary.isLoading) return <LoadingState label="Loading dashboard…" />;
  if (summary.error) return <ErrorState error={summary.error} />;
  const s = summary.data!;

  const money = (buckets: CurrencyBucket[]) =>
    buckets.map((b) => formatMoney(b.cents, b.currency)).join(", ") || "—";
  const counts = (by: Record<string, number>) =>
    Object.entries(by)
      .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
      .join(", ") || "—";

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="stat-grid">
        <StatCard label="Overdue invoices" value={String(s.overdue_invoices.count)} sub={money(s.overdue_invoices.by_currency)} />
        <StatCard label="Open deal value" value={`${s.open_deals.count} deals`} sub={money(s.open_deals.by_currency)} />
        <StatCard label="Open tickets" value={String(s.open_tickets.count)} sub={counts(s.open_tickets.by_priority)} />
        <StatCard label="Active issues" value={String(s.active_issues.count)} sub={counts(s.active_issues.by_status)} />
      </div>

      <h2>Accounts receivable aging</h2>
      {aging.isLoading && <LoadingState />}
      {aging.error && <ErrorState error={aging.error} />}
      {aging.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Age</th>
              <th style={{ textAlign: "right" }}>Invoices</th>
              <th style={{ textAlign: "right" }}>Outstanding (cents)</th>
            </tr>
          </thead>
          <tbody>
            {aging.data.buckets.map((b) => (
              <tr key={b.bucket}>
                <td>{AGING_LABELS[b.bucket] ?? b.bucket}</td>
                <td style={{ textAlign: "right" }}>{b.count}</td>
                <td style={{ textAlign: "right" }}>{(b.cents / 100).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}
