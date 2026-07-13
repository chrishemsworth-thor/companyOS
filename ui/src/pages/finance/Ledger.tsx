import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
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
      <div className="page-header">
        <h1>Chart of accounts</h1>
        <button className="btn btn-primary" onClick={() => setPosting(true)}>
          New journal entry
        </button>
      </div>
      {posting && <JournalEntryModal accounts={accounts} onClose={() => setPosting(false)} />}
      {openEntry && (
        <JournalEntryDetailModal
          entryId={openEntry}
          accounts={accounts}
          onClose={() => setOpenEntry(null)}
        />
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Type</th>
            <th style={{ textAlign: "right" }}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <AccountRow key={account.account_id} account={account} />
          ))}
        </tbody>
      </table>

      <h2>Journal entries</h2>
      {entriesQuery.isLoading && <LoadingState />}
      {entriesQuery.error && <ErrorState error={entriesQuery.error} />}
      {entriesQuery.data && entriesQuery.data.entries.length === 0 && (
        <div className="empty-state">No journal entries yet.</div>
      )}
      {entriesQuery.data && entriesQuery.data.entries.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Memo</th>
              <th>Source</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {entriesQuery.data.entries.map((e) => (
              <tr key={e.entry_id} className="clickable" onClick={() => setOpenEntry(e.entry_id)}>
                <td>{e.entry_date}</td>
                <td>{e.memo ?? "—"}</td>
                <td>{e.source_type}</td>
                <td style={{ textAlign: "right" }}>{formatCents(e.total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AccountRow({ account }: { account: Account }) {
  const { client } = useAuth();
  const balanceQuery = useQuery({
    queryKey: ["ledger", "balance", account.account_id],
    queryFn: () =>
      client!.get<AccountBalance>(`/v1/ledger/accounts/${account.account_id}/balance`),
    enabled: !!client,
  });

  return (
    <tr>
      <td>{account.code}</td>
      <td>{account.name}</td>
      <td>{account.type}</td>
      <td style={{ textAlign: "right" }}>
        {balanceQuery.data ? formatCents(balanceQuery.data.balance_cents) : "…"}
      </td>
    </tr>
  );
}
