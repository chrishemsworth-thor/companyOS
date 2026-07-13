import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { JournalEntryModal } from "../../components/modals/JournalEntryModal";
import { JournalEntryDetailModal } from "../../components/modals/JournalEntryDetailModal";
import { formatCents } from "../../lib/format";
import type { Account, AccountBalance, EntrySummary } from "../../api/types";

export function Ledger() {
  const { client } = useAuth();
  const [posting, setPosting] = useState(false);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const accountsQuery = useQuery({
    queryKey: ["ledger", "accounts"],
    queryFn: () => client!.get<{ accounts: Account[] }>("/v1/ledger/accounts"),
    enabled: !!client,
  });
  const entriesQuery = useQuery({
    queryKey: ["ledger", "entries"],
    queryFn: () => client!.get<{ entries: EntrySummary[] }>("/v1/ledger/entries"),
    enabled: !!client,
  });

  if (accountsQuery.isLoading) return <LoadingState />;
  if (accountsQuery.error) return <ErrorState error={accountsQuery.error} />;
  const accounts = accountsQuery.data?.accounts ?? [];

  return (
    <div>
      <PageHeader title="Chart of accounts">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setPosting(true)}>
          New journal entry
        </Button>
      </PageHeader>
      {posting && <JournalEntryModal accounts={accounts} onClose={() => setPosting(false)} />}
      {openEntry && (
        <JournalEntryDetailModal
          entryId={openEntry}
          accounts={accounts}
          onClose={() => setOpenEntry(null)}
        />
      )}

      <DataTable
        rows={accounts}
        rowKey={(a) => a.account_id}
        columns={[
          { header: "Code", render: (a) => <span className="font-mono text-[0.85em]">{a.code}</span> },
          { header: "Name", render: (a) => a.name },
          { header: "Type", render: (a) => <span className="capitalize">{a.type}</span> },
          { header: "Balance", render: (a) => <AccountBalanceCell account={a} />, align: "right" },
        ]}
      />

      <h2>Journal entries</h2>
      {entriesQuery.isLoading && <LoadingState />}
      {entriesQuery.error && <ErrorState error={entriesQuery.error} />}
      {entriesQuery.data && (
        <DataTable
          rows={entriesQuery.data.entries}
          rowKey={(e) => e.entry_id}
          onRowClick={(e) => setOpenEntry(e.entry_id)}
          emptyLabel="No journal entries yet."
          columns={[
            { header: "Date", render: (e) => e.entry_date },
            { header: "Memo", render: (e) => e.memo ?? "—" },
            { header: "Source", render: (e) => <span className="capitalize">{e.source_type}</span> },
            { header: "Amount", render: (e) => formatCents(e.total_cents), align: "right" },
          ]}
        />
      )}
    </div>
  );
}

function AccountBalanceCell({ account }: { account: Account }) {
  const { client } = useAuth();
  const balanceQuery = useQuery({
    queryKey: ["ledger", "balance", account.account_id],
    queryFn: () => client!.get<AccountBalance>(`/v1/ledger/accounts/${account.account_id}/balance`),
    enabled: !!client,
  });

  return <>{balanceQuery.data ? formatCents(balanceQuery.data.balance_cents) : "…"}</>;
}
