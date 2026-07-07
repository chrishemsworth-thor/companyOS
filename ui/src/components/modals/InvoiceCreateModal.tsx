import { useMemo, useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { CustomerSelect } from "../CustomerSelect";
import { useApiMutation } from "../../hooks/useApiMutation";
import { parseAmountToCents } from "../../lib/money";
import type { Invoice } from "../../api/types";

interface LineDraft {
  description: string;
  quantity: string;
  unitAmount: string;
}

const EMPTY_LINE: LineDraft = { description: "", quantity: "1", unitAmount: "" };

export function InvoiceCreateModal({
  defaultCustomerId,
  onClose,
  onCreated,
}: {
  defaultCustomerId?: string;
  onClose: () => void;
  onCreated?: (invoice: Invoice) => void;
}) {
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? "");
  const [currency, setCurrency] = useState("MYR");
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);
  const [validationError, setValidationError] = useState<string | null>(null);
  // One key per form-open: a double-click or network retry replays the
  // original invoice instead of issuing a duplicate.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const mutation = useApiMutation({
    mutationFn: (
      client,
      body: {
        customer_id: string;
        currency: string;
        due_date: string;
        lines: { description: string; quantity: number; unit_cents: number }[];
      },
    ) => client.post<Invoice>("/v1/invoices", body, { idempotencyKey }),
    invalidates: (vars) => [["invoices"], ["customer", vars.customer_id]],
    onSuccess: (invoice) => {
      onClose();
      onCreated?.(invoice);
    },
  });

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const totalCents = lines.reduce((sum, l) => {
    const unit = parseAmountToCents(l.unitAmount);
    const qty = parseInt(l.quantity, 10);
    return unit !== null && qty > 0 ? sum + unit * qty : sum;
  }, 0);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    const parsedLines = [];
    for (const l of lines) {
      const unit_cents = parseAmountToCents(l.unitAmount);
      const quantity = parseInt(l.quantity, 10);
      if (!l.description.trim() || unit_cents === null || !(quantity > 0)) {
        setValidationError("Each line needs a description, a positive quantity, and a valid unit price.");
        return;
      }
      parsedLines.push({ description: l.description.trim(), quantity, unit_cents });
    }
    mutation.mutate({ customer_id: customerId, currency, due_date: dueDate, lines: parsedLines });
  };

  return (
    <Modal title="New invoice" onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Customer">
          <CustomerSelect value={customerId} onChange={setCustomerId} disabled={!!defaultCustomerId} />
        </FormRow>
        <div className="form-row-inline">
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
          <FormRow label="Due date">
            <input
              className="input"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              required
            />
          </FormRow>
        </div>

        <div className="field-label">Line items</div>
        {lines.map((line, i) => (
          <div className="form-row-inline" key={i}>
            <input
              className="input"
              placeholder="Description"
              value={line.description}
              onChange={(e) => setLine(i, { description: e.target.value })}
              style={{ flex: 2 }}
            />
            <input
              className="input"
              placeholder="Qty"
              inputMode="numeric"
              value={line.quantity}
              onChange={(e) => setLine(i, { quantity: e.target.value })}
            />
            <input
              className="input"
              placeholder="Unit price"
              inputMode="decimal"
              value={line.unitAmount}
              onChange={(e) => setLine(i, { unitAmount: e.target.value })}
            />
            {lines.length > 1 && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ flex: "0 0 auto" }}
                onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="action-bar">
          <button type="button" className="btn btn-sm" onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}>
            + Add line
          </button>
          <span className="muted">
            Total: {currency} {(totalCents / 100).toFixed(2)}
          </span>
        </div>

        <FormError error={validationError ?? mutation.error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending || !customerId}>
            {mutation.isPending ? "Creating…" : "Create invoice"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
