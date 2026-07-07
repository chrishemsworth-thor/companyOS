import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { useApiMutation } from "../../hooks/useApiMutation";
import type { Customer } from "../../api/types";

/** Create a customer, or edit one when `existing` is passed. */
export function CustomerFormModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Customer;
  onClose: () => void;
  onSaved?: (customer: Customer) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? "");

  const mutation = useApiMutation({
    mutationFn: (client, body: { name: string; email?: string; phone?: string }) =>
      existing
        ? client.patch<Customer>(`/v1/customers/${existing.customer_id}`, body)
        : client.post<Customer>("/v1/customers", body),
    invalidates: () =>
      existing ? [["customers"], ["customer", existing.customer_id]] : [["customers"]],
    onSuccess: (customer) => {
      onClose();
      onSaved?.(customer);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
      name: name.trim(),
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
    });
  };

  return (
    <Modal title={existing ? "Edit customer" : "New customer"} onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </FormRow>
        <FormRow label="Email (optional)">
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </FormRow>
        <FormRow label="Phone (optional)">
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </FormRow>
        <FormError error={mutation.error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : existing ? "Save changes" : "Create customer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
