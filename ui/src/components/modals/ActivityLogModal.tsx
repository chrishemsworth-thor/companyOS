import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";

const KINDS = ["note", "call", "email", "meeting"] as const;

export function ActivityLogModal({
  customerId,
  dealId,
  onClose,
}: {
  customerId: string;
  dealId?: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>("note");
  const [body, setBody] = useState("");

  const mutation = useApiMutation({
    mutationFn: (client, vars: { kind: string; body?: string }) =>
      client.post("/v1/activities", {
        customer_id: customerId,
        ...(dealId ? { deal_id: dealId } : {}),
        kind: vars.kind,
        ...(vars.body ? { body: vars.body } : {}),
      }),
    invalidates: () => [["customer", customerId, "activities"]],
    onSuccess: onClose,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({ kind, body: body.trim() || undefined });
  };

  return (
    <Modal title="Log activity" onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Kind">
          <select
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="Notes (optional)">
          <textarea
            className="input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={5000}
          />
        </FormRow>
        <FormError error={mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Logging…" : "Log activity"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
