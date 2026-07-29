import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Receipt, TrendingUp, LifeBuoy, CircleDot, CheckSquare, type LucideIcon } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState } from "../components/AsyncState";
import { DataTable } from "../components/DataTable";
import { formatCents, formatMoney } from "../lib/format";

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

type ProfitabilityGroupBy = "project" | "customer" | "department";
interface ProfitabilityRow {
  key: string | null;
  label: string;
  revenue_cents: number;
  cost_cents: number;
  margin_cents: number;
  margin_pct: number | null;
}
interface Profitability {
  group_by: ProfitabilityGroupBy;
  rows: ProfitabilityRow[];
}

const GROUP_BY_LABELS: Record<ProfitabilityGroupBy, string> = {
  project: "Project",
  customer: "Customer",
  department: "Department",
};

const AGING_LABELS: Record<string, string> = {
  current: "Not yet due",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "60+": "60+ days",
};

type Tone = "accent" | "bad" | "good" | "warn";
const TONE_CHIP: Record<Tone, string> = {
  accent: "bg-accent-soft text-accent",
  bad: "bg-bad-bg text-bad",
  good: "bg-good-bg text-good",
  warn: "bg-warn-bg text-warn",
};

export function Dashboard() {
  const { client } = useAuth();
  const [groupBy, setGroupBy] = useState<ProfitabilityGroupBy>("project");

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
  const profit = useQuery({
    queryKey: ["insights", "profitability", groupBy],
    queryFn: () => client!.get<Profitability>(`/v1/insights/profitability?group_by=${groupBy}`),
    enabled: !!client,
  });
  // "Needs your attention" (PRD-007 § "P0 — Dashboard integration"). Shares the
  // ["approvals"] key prefix with the inbox, so deciding something there
  // refreshes this tile too.
  const awaitingMe = useQuery({
    queryKey: ["approvals", "awaiting-count"],
    queryFn: () =>
      client!.get<{ items: unknown[] }>("/v1/approvals?mine=true&state=pending&limit=100"),
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* First tile, because it is the only one on this dashboard that asks the
            viewer to *do* something rather than telling them how the business is
            doing. PRD-007: "nothing awaiting action is discoverable only by
            remembering to look." */}
        <StatCard
          icon={CheckSquare}
          tone="warn"
          label="Needs your attention"
          value={
            awaitingMe.data ? `${awaitingMe.data.items.length} to decide` : "—"
          }
          sub={
            awaitingMe.data?.items.length
              ? "Oldest first in the approvals inbox"
              : "Nothing waiting on you"
          }
          to="/approvals"
        />
        <StatCard
          icon={Receipt}
          tone="bad"
          label="Overdue invoices"
          value={String(s.overdue_invoices.count)}
          sub={money(s.overdue_invoices.by_currency)}
        />
        <StatCard
          icon={TrendingUp}
          tone="accent"
          label="Open deal value"
          value={`${s.open_deals.count} deals`}
          sub={money(s.open_deals.by_currency)}
        />
        <StatCard
          icon={LifeBuoy}
          tone="warn"
          label="Open tickets"
          value={String(s.open_tickets.count)}
          sub={counts(s.open_tickets.by_priority)}
        />
        <StatCard
          icon={CircleDot}
          tone="good"
          label="Active issues"
          value={String(s.active_issues.count)}
          sub={counts(s.active_issues.by_status)}
        />
      </div>

      <h2>Accounts receivable aging</h2>
      {aging.isLoading && <LoadingState />}
      {aging.error && <ErrorState error={aging.error} />}
      {aging.data && (
        <DataTable
          rows={aging.data.buckets}
          rowKey={(b) => b.bucket}
          columns={[
            { header: "Age", render: (b) => AGING_LABELS[b.bucket] ?? b.bucket },
            { header: "Invoices", render: (b) => b.count, align: "right" },
            {
              header: "Outstanding (cents)",
              render: (b) => (b.cents / 100).toLocaleString(),
              align: "right",
            },
          ]}
        />
      )}

      <h2>Profitability</h2>
      <p className="mb-3 text-sm text-subtle">
        Revenue and direct cost from the dimensioned ledger. Cost counts tagged expense
        postings only — labour is not included.
      </p>
      <div className="mb-3 flex gap-2">
        {(Object.keys(GROUP_BY_LABELS) as ProfitabilityGroupBy[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGroupBy(g)}
            aria-pressed={groupBy === g}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
              groupBy === g
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-muted hover:text-fg"
            }`}
          >
            {GROUP_BY_LABELS[g]}
          </button>
        ))}
      </div>
      {profit.isLoading && <LoadingState />}
      {profit.error && <ErrorState error={profit.error} />}
      {profit.data && (
        <DataTable
          rows={profit.data.rows}
          // key is null for the Unallocated bucket, which is always a single row.
          rowKey={(r) => r.key ?? "__unallocated"}
          columns={[
            {
              header: GROUP_BY_LABELS[profit.data.group_by],
              render: (r) => (
                <span className={r.key === null ? "text-subtle italic" : undefined}>{r.label}</span>
              ),
            },
            { header: "Revenue", render: (r) => formatCents(r.revenue_cents), align: "right" },
            { header: "Direct cost", render: (r) => formatCents(r.cost_cents), align: "right" },
            {
              header: "Margin",
              render: (r) => (
                <span className={r.margin_cents < 0 ? "text-bad" : undefined}>
                  {formatCents(r.margin_cents)}
                </span>
              ),
              align: "right",
            },
            {
              header: "Margin %",
              // Null when there is no revenue to divide by — cost-only buckets.
              render: (r) => (r.margin_pct === null ? "—" : `${r.margin_pct}%`),
              align: "right",
            },
          ]}
        />
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  tone,
  label,
  value,
  sub,
  to,
}: {
  icon: LucideIcon;
  tone: Tone;
  label: string;
  value: string;
  sub: string;
  /** When set the whole tile is a link. Used by the approvals tile. */
  to?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${TONE_CHIP[tone]}`}>
          <Icon className="size-[1.05rem]" />
        </span>
        <div className="text-sm font-medium text-muted">{label}</div>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-fg">{value}</div>
      <div className="mt-1 text-sm text-subtle">{sub}</div>
    </>
  );
  const shell = "rounded-xl border border-border bg-surface p-5 shadow-sm";

  if (to) {
    return (
      <Link
        to={to}
        className={`${shell} block no-underline transition-colors hover:border-border-strong hover:bg-surface-2 hover:no-underline`}
      >
        {body}
      </Link>
    );
  }
  return <div className={shell}>{body}</div>;
}
