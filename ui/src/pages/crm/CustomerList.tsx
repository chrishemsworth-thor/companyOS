import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { CustomerFormModal } from "../../components/modals/CustomerFormModal";
import type { Customer } from "../../api/types";

export function CustomerList() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["customers"],
    queryFn: () => client!.get<{ customers: Customer[] }>("/v1/customers"),
    enabled: !!client,
  });

  return (
    <div>
      <PageHeader title="Customers">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New customer
        </Button>
      </PageHeader>
      {creating && (
        <CustomerFormModal
          onClose={() => setCreating(false)}
          onSaved={(customer) => navigate(`/customers/${customer.customer_id}`)}
        />
      )}
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
