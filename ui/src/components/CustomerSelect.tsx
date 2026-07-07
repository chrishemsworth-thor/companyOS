import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import type { Customer } from "../api/types";

/** Customer picker fed by /v1/customers; disabled while loading. */
export function CustomerSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (customerId: string) => void;
  disabled?: boolean;
}) {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["customers"],
    queryFn: () => client!.get<{ customers: Customer[] }>("/v1/customers?limit=200"),
    enabled: !!client,
  });

  return (
    <select
      className="input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || query.isLoading}
      required
    >
      <option value="" disabled>
        {query.isLoading ? "Loading customers…" : "Select customer"}
      </option>
      {query.data?.customers.map((c) => (
        <option key={c.customer_id} value={c.customer_id}>
          {c.name} ({c.customer_id})
        </option>
      ))}
    </select>
  );
}
