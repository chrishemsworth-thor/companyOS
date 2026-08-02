import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";
import { CONTACT_ROLES, CONTACT_ROLE_LABELS, type Contact, type ContactRole } from "../../api/types";

interface ContactBody {
  name: string;
  title?: string;
  department?: string;
  email?: string;
  phone?: string;
  roles: ContactRole[];
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
  // Roles are the single control (PRD-003). The old standalone "primary"
  // checkbox is gone rather than kept alongside: `is_primary` and the `primary`
  // role are one fact, and two controls for one fact is how they drift.
  // A new contact starts with nothing selected — the API then applies its own
  // default (primary if this is the customer's first contact, otherwise other).
  const [roles, setRoles] = useState<ContactRole[]>(existing?.roles ?? []);

  const toggleRole = (role: ContactRole) =>
    setRoles((current) =>
      current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    );

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
      roles,
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
        <FormRow label="Roles">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {CONTACT_ROLES.map((role) => (
              <label key={role} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={() => toggleRole(role)}
                />
                {CONTACT_ROLE_LABELS[role]}
              </label>
            ))}
          </div>
        </FormRow>
        {roles.includes("primary") && !existing?.is_primary && (
          <p className="text-xs text-muted">
            Marking this contact primary clears the customer's current primary.
          </p>
        )}
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
