import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { JournalEntryModal } from "../../components/modals/JournalEntryModal";
import { formatCents } from "../../lib/format";
import type { Account, AccountBalance } from "../../api/types";

export function Ledger() {
  const { client } = useAuth();
  const [posting, setPosting] = useState(false);
  const accountsQuery = useQuery({
    queryKey: ["ledger", "accounts"],
    queryFn: () => client!.get<{ accounts: Account[] }>("/v1/ledger/accounts"),
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
