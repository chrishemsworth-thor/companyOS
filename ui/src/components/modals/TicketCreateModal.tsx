import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { CustomerSelect } from "../CustomerSelect";
import { useApiMutation } from "../../hooks/useApiMutation";
import type { Ticket, TicketPriority } from "../../api/types";

const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

export function TicketCreateModal({
  defaultCustomerId,
  onClose,
  onCreated,
}: {
  defaultCustomerId?: string;
  onClose: () => void;
  onCreated?: (ticket: Ticket) => void;
}) {
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? "");
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [body, setBody] = useState("");

  const mutation = useApiMutation({
    mutationFn: (
      client,
      vars: { customer_id: string; subject: string; priority: TicketPriority; body?: string },
    ) => client.post<Ticket>("/v1/tickets", vars),
    invalidates: (vars) => [["tickets"], ["customer", vars.customer_id]],
    onSuccess: (ticket) => {
      onClose();
      onCreated?.(ticket);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
      customer_id: customerId,
      subject: subject.trim(),
      priority,
      ...(body.trim() ? { body: body.trim() } : {}),
    });
  };

  return (
    <Modal title="New ticket" onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Customer">
          <CustomerSelect value={customerId} onChange={setCustomerId} disabled={!!defaultCustomerId} />
        </FormRow>
        <FormRow label="Subject">
          <input
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={300}
            required
          />
        </FormRow>
        <FormRow label="Priority">
          <select
            className="input"
            value={priority}
            onChange={(e) => setPriority(e.target.value as TicketPriority)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="First message (optional)">
          <textarea
            className="input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={10_000}
          />
        </FormRow>
        <FormError error={mutation.error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={mutation.isPending || !customerId}
          >
            {mutation.isPending ? "Creating…" : "Create ticket"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
