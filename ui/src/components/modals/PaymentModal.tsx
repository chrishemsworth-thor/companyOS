import { useMemo, useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { useApiMutation } from "../../hooks/useApiMutation";
import { parseAmountToCents, centsToAmountString } from "../../lib/money";
import type { Invoice } from "../../api/types";

/** Record a payment applied to a single invoice. */
export function PaymentModal({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const [amount, setAmount] = useState(centsToAmountString(invoice.amount_due_cents));
  const [method, setMethod] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const mutation = useApiMutation({
    mutationFn: (client, body: { amount_cents: number; method?: string }) =>
      client.post(
        "/v1/payments",
        {
          customer_id: invoice.customer_id,
          amount_cents: body.amount_cents,
          currency: invoice.currency,
          ...(body.method ? { method: body.method } : {}),
          applications: [{ invoice_id: invoice.invoice_id, applied_cents: body.amount_cents }],
        },
        { idempotencyKey },
      ),
    invalidates: () => [
      ["invoice", invoice.invoice_id],
      ["invoices"],
      ["customer", invoice.customer_id],
      ["ledger"],
    ],
    onSuccess: onClose,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    const amount_cents = parseAmountToCents(amount);
    if (amount_cents === null || amount_cents <= 0) {
      setValidationError("Enter a valid positive amount.");
      return;
    }
    mutation.mutate({ amount_cents, method: method.trim() || undefined });
  };

  return (
    <Modal title="Record payment" onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label={`Amount (${invoice.currency})`}>
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </FormRow>
        <FormRow label="Method (optional)">
          <input
            className="input"
            placeholder="bank_transfer, cash…"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          />
        </FormRow>
        <FormError error={validationError ?? mutation.error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Recording…" : "Record payment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
