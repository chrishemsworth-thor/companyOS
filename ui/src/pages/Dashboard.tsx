import { useQuery } from "@tanstack/react-query";
import { Receipt, TrendingUp, LifeBuoy, CircleDot, type LucideIcon } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState } from "../components/AsyncState";
import { DataTable } from "../components/DataTable";
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

type Tone = "accent" | "bad" | "good" | "warn";
const TONE_CHIP: Record<Tone, string> = {
  accent: "bg-accent-soft text-accent",
  bad: "bg-bad-bg text-bad",
  good: "bg-good-bg text-good",
  warn: "bg-warn-bg text-warn",
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
    </div>
  );
}

function StatCard({
  icon: Icon,
  tone,
  label,
  value,
  sub,
}: {
  icon: LucideIcon;
  tone: Tone;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${TONE_CHIP[tone]}`}>
          <Icon className="size-[1.05rem]" />
        </span>
        <div className="text-sm font-medium text-muted">{label}</div>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-fg">{value}</div>
      <div className="mt-1 text-sm text-subtle">{sub}</div>
    </div>
  );
}
