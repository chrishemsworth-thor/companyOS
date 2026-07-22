import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";
import type { Contact } from "../../api/types";

interface ContactBody {
  name: string;
  title?: string;
  department?: string;
  email?: string;
  phone?: string;
  is_primary?: boolean;
}

/** Create a contact person at a customer, or edit one when `existing` is passed. */
export function ContactFormModal({
  customerId,
  existing,
  onClose,
  onSaved,
}: {
  customerId: string;
  existing?: Contact;
  onClose: () => void;
  onSaved?: (contact: Contact) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [department, setDepartment] = useState(existing?.department ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? "");
  const [isPrimary, setIsPrimary] = useState(existing?.is_primary ?? false);

  const mutation = useApiMutation({
    mutationFn: (client, body: ContactBody) =>
      existing
        ? client.patch<Contact>(
            `/v1/customers/${customerId}/contacts/${existing.contact_id}`,
            body,
          )
        : client.post<Contact>(`/v1/customers/${customerId}/contacts`, body),
    invalidates: () => [["contacts", customerId]],
    successMessage: existing ? "Contact updated" : "Contact added",
    onSuccess: (contact) => {
      onClose();
      onSaved?.(contact);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
      name: name.trim(),
      title: title.trim() || undefined,
      department: department.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      is_primary: isPrimary,
    });
  };

  return (
    <Modal title={existing ? "Edit contact" : "New contact"} onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </FormRow>
        <FormRow label="Title (optional)">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormRow>
        <FormRow label="Department (optional)">
          <input
            className="input"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
          />
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
        <FormRow label="">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />
            Primary contact
          </label>
        </FormRow>
        <FormError error={mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : existing ? "Save changes" : "Add contact"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
