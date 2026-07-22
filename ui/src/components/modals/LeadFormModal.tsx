import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";
import type { Lead } from "../../api/types";

interface LeadBody {
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  title?: string;
  source?: string;
  notes?: string;
}

/** Create a lead, or edit one when `existing` is passed. */
export function LeadFormModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Lead;
  onClose: () => void;
  onSaved?: (lead: Lead) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [company, setCompany] = useState(existing?.company ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? "");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [source, setSource] = useState(existing?.source ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");

  const mutation = useApiMutation({
    mutationFn: (client, body: LeadBody) =>
      existing
        ? client.patch<Lead>(`/v1/leads/${existing.lead_id}`, body)
        : client.post<Lead>("/v1/leads", body),
    invalidates: () => (existing ? [["leads"], ["lead", existing.lead_id]] : [["leads"]]),
    successMessage: existing ? "Lead updated" : "Lead created",
    onSuccess: (lead) => {
      onClose();
      onSaved?.(lead);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
      name: name.trim(),
      company: company.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      title: title.trim() || undefined,
      source: source.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <Modal title={existing ? "Edit lead" : "New lead"} onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </FormRow>
        <FormRow label="Company (optional)">
          <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} />
        </FormRow>
        <FormRow label="Title (optional)">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormRow>
        <div className="form-row-inline">
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
        </div>
        <FormRow label="Source (optional — defaults to manual)">
          <input
            className="input"
            placeholder="manual, referral, webform…"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </FormRow>
        <FormRow label="Notes (optional)">
          <textarea
            className="input"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </FormRow>
        <FormError error={mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : existing ? "Save changes" : "Create lead"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
