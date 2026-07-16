import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import type { Contact } from "../api/types";

/** Contact picker fed by /v1/customers/:id/contacts; empty until a customer is chosen. */
export function ContactSelect({
  customerId,
  value,
  onChange,
  disabled,
}: {
  customerId: string;
  value: string;
  onChange: (contactId: string) => void;
  disabled?: boolean;
}) {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["contacts", customerId],
    queryFn: () => client!.get<{ contacts: Contact[] }>(`/v1/customers/${customerId}/contacts`),
    enabled: !!client && !!customerId,
  });

  return (
    <select
      className="input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || !customerId || query.isLoading}
    >
      <option value="">{customerId ? "No contact" : "Select a customer first"}</option>
      {query.data?.contacts.map((c) => (
        <option key={c.contact_id} value={c.contact_id}>
          {c.name}
          {c.title ? ` — ${c.title}` : ""}
        </option>
      ))}
    </select>
  );
}
