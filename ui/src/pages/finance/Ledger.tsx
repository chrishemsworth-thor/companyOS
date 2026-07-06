import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { formatCents } from "../../lib/format";
import type { Account, AccountBalance } from "../../api/types";

export function Ledger() {
  const { client } = useAuth();
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
      <h1>Chart of accounts</h1>
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
