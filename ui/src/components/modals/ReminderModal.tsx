import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";

/** Trigger an agent-composed payment nudge via the delivery port. */
export function ReminderModal({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const [channel, setChannel] = useState<"email" | "whatsapp">("email");
  const [message, setMessage] = useState("");

  const mutation = useApiMutation({
    mutationFn: (client, body: { channel: string; message?: string }) =>
      client.post(`/v1/invoices/${invoiceId}/reminder`, body),
    invalidates: () => [["events"], ["customer"]],
    onSuccess: onClose,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({ channel, message: message.trim() || undefined });
  };

  return (
    <Modal title="Send reminder" onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Channel">
          <select
            className="input"
            value={channel}
            onChange={(e) => setChannel(e.target.value as "email" | "whatsapp")}
          >
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
        </FormRow>
        <FormRow label="Message (optional — template used when blank)">
          <textarea
            className="input"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={2000}
          />
        </FormRow>
        <FormError error={mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Sending…" : "Send reminder"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
