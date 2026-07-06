import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import type { Customer } from "../../api/types";

export function CustomerList() {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["customers"],
    queryFn: () => client!.get<{ customers: Customer[] }>("/v1/customers"),
    enabled: !!client,
  });

  return (
    <div>
      <h1>Customers</h1>
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.customers}
          rowKey={(r) => r.customer_id}
          rowHref={(r) => `/customers/${r.customer_id}`}
          columns={[
            { header: "Customer", render: (r) => r.name },
            { header: "Email", render: (r) => r.email ?? "—" },
            { header: "Phone", render: (r) => r.phone ?? "—" },
          ]}
        />
      )}
    </div>
  );
}
