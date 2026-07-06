import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState } from "../components/AsyncState";
import { formatMoney } from "../lib/format";
import type { Invoice, Deal, Ticket, Issue } from "../api/types";

export function Dashboard() {
  const { client } = useAuth();
  if (!client) return null;

  const invoicesQuery = useQuery({
    queryKey: ["dashboard", "invoices"],
    queryFn: () => client.get<{ invoices: Invoice[] }>("/v1/invoices"),
  });
  const dealsQuery = useQuery({
    queryKey: ["dashboard", "deals"],
    queryFn: () => client.get<{ deals: Deal[] }>("/v1/deals?status=open"),
  });
  const ticketsQuery = useQuery({
    queryKey: ["dashboard", "tickets"],
    queryFn: () => client.get<{ tickets: Ticket[] }>("/v1/tickets"),
  });
  const issuesQuery = useQuery({
    queryKey: ["dashboard", "issues"],
    queryFn: () => client.get<{ issues: Issue[] }>("/v1/issues"),
  });

  if (invoicesQuery.isLoading || dealsQuery.isLoading || ticketsQuery.isLoading || issuesQuery.isLoading) {
    return <LoadingState label="Loading dashboard…" />;
  }
  const firstError = invoicesQuery.error ?? dealsQuery.error ?? ticketsQuery.error ?? issuesQuery.error;
  if (firstError) return <ErrorState error={firstError} />;

  const invoices = invoicesQuery.data?.invoices ?? [];
  const overdue = invoices.filter((i) => i.status === "overdue");
  const overdueTotalByCurrency = groupSum(overdue, (i) => i.currency, (i) => i.amount_due_cents);

  const deals = dealsQuery.data?.deals ?? [];
  const openDealsTotalByCurrency = groupSum(deals, (d) => d.currency, (d) => d.value_cents);

  const tickets = ticketsQuery.data?.tickets ?? [];
  const ticketsByPriority = groupCount(tickets, (t) => t.priority);

  const issues = issuesQuery.data?.issues ?? [];
  const issuesByStatus = groupCount(
    issues.filter((i) => i.status !== "done" && i.status !== "cancelled"),
    (i) => i.status,
  );

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="stat-grid">
        <StatCard
          label="Overdue invoices"
          value={String(overdue.length)}
          sub={Object.entries(overdueTotalByCurrency)
            .map(([cur, cents]) => formatMoney(cents, cur))
            .join(", ") || "—"}
        />
        <StatCard
          label="Open deal value"
          value={String(deals.length) + " deals"}
          sub={Object.entries(openDealsTotalByCurrency)
            .map(([cur, cents]) => formatMoney(cents, cur))
            .join(", ") || "—"}
        />
        <StatCard
          label="Open tickets"
          value={String(tickets.filter((t) => t.status !== "closed").length)}
          sub={Object.entries(ticketsByPriority)
            .map(([p, n]) => `${n} ${p}`)
            .join(", ") || "—"}
        />
        <StatCard
          label="Active issues"
          value={String(issues.length - (issuesByStatus["done"] ?? 0) - (issuesByStatus["cancelled"] ?? 0))}
          sub={Object.entries(issuesByStatus)
            .map(([s, n]) => `${n} ${s.replace("_", " ")}`)
            .join(", ") || "—"}
        />
      </div>
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

function groupSum<T>(rows: T[], keyFn: (r: T) => string, valueFn: (r: T) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row);
    out[key] = (out[key] ?? 0) + valueFn(row);
  }
  return out;
}

function groupCount<T>(rows: T[], keyFn: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
