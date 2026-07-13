import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { CustomerSelect } from "../CustomerSelect";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useAuth } from "../../auth/AuthContext";
import { useApiMutation } from "../../hooks/useApiMutation";
import { parseAmountToCents } from "../../lib/money";
import type { Deal, PipelineStage } from "../../api/types";

export function DealCreateModal({
  defaultCustomerId,
  onClose,
  onCreated,
}: {
  defaultCustomerId?: string;
  onClose: () => void;
  onCreated?: (deal: Deal) => void;
}) {
  const { client } = useAuth();
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? "");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("MYR");
  const [stageId, setStageId] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const stagesQuery = useQuery({
    queryKey: ["deals", "stages"],
    queryFn: () => client!.get<{ stages: PipelineStage[] }>("/v1/deals/stages"),
    enabled: !!client,
  });

  const mutation = useApiMutation({
    mutationFn: (
      client,
      body: {
        customer_id: string;
        title: string;
        value_cents: number;
        currency: string;
        stage_id?: string;
      },
    ) => client.post<Deal>("/v1/deals", body),
    invalidates: (vars) => [["deals"], ["customer", vars.customer_id]],
    onSuccess: (deal) => {
      onClose();
      onCreated?.(deal);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    const value_cents = parseAmountToCents(value);
    if (value_cents === null) {
      setValidationError("Enter a valid deal value.");
      return;
    }
    mutation.mutate({
      customer_id: customerId,
      title: title.trim(),
      value_cents,
      currency,
      ...(stageId ? { stage_id: stageId } : {}),
    });
  };

  return (
    <Modal title="New deal" onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Customer">
          <CustomerSelect value={customerId} onChange={setCustomerId} disabled={!!defaultCustomerId} />
        </FormRow>
        <FormRow label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </FormRow>
        <div className="form-row-inline">
          <FormRow label="Value">
            <input
              className="input"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </FormRow>
          <FormRow label="Currency">
            <input
              className="input"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              minLength={3}
              required
            />
          </FormRow>
        </div>
        <FormRow label="Stage (optional — defaults to first stage)">
          <select className="input" value={stageId} onChange={(e) => setStageId(e.target.value)}>
            <option value="">Default</option>
            {stagesQuery.data?.stages.map((s) => (
              <option key={s.stage_id} value={s.stage_id}>
                {s.name}
              </option>
            ))}
          </select>
        </FormRow>
        <FormError error={validationError ?? mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={mutation.isPending}
            disabled={mutation.isPending || !customerId}
          >
            {mutation.isPending ? "Creating…" : "Create deal"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
