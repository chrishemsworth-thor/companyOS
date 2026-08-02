import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { CustomerSelect } from "../CustomerSelect";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { CurrencySelect } from "../CurrencySelect";
import { useAuth } from "../../auth/AuthContext";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useBaseCurrency } from "../../hooks/useBaseCurrency";
import { parseAmountToCents } from "../../lib/money";
import type { Customer, Invoice } from "../../api/types";

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
  // Defaults to the company base currency until the user picks one explicitly.
  const baseCurrency = useBaseCurrency();
  const [currencyOverride, setCurrencyOverride] = useState<string | null>(null);
  const currency = currencyOverride ?? baseCurrency;
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);
  const [validationError, setValidationError] = useState<string | null>(null);
  // One key per form-open: a double-click or network retry replays the
  // original invoice instead of issuing a duplicate.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  // Credit exposure for the warning below. Only the detail endpoint carries it,
  // and only once a customer is picked.
  const { client } = useAuth();
  const creditQuery = useQuery({
    queryKey: ["customer", customerId],
    queryFn: () => client!.get<Customer>(`/v1/customers/${customerId}`),
    enabled: !!client && !!customerId,
  });

  const mutation = useApiMutation({
    mutationFn: (
      client,
      body: {
        customer_id: string;
        currency: string;
        due_date?: string;
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

  const credit = creditQuery.data?.credit;
  const creditWarning =
    credit && credit.limit_cents !== null && credit.outstanding_ar_cents + totalCents > credit.limit_cents
      ? `This invoice takes ${creditQuery.data!.name} to ${currency} ${(
          (credit.outstanding_ar_cents + totalCents) / 100
        ).toFixed(2)} against a ${currency} ${(credit.limit_cents / 100).toFixed(2)} credit limit.`
      : null;

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
    mutation.mutate({
      customer_id: customerId,
      currency,
      // Omitted rather than sent blank: the API then derives the due date from
      // the customer's payment terms (PRD-003), which is the whole point of
      // storing them.
      due_date: dueDate || undefined,
      lines: parsedLines,
    });
  };

  return (
    <Modal title="New invoice" onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Customer">
          <CustomerSelect value={customerId} onChange={setCustomerId} disabled={!!defaultCustomerId} />
        </FormRow>
        <div className="form-row-inline">
          <FormRow label="Currency">
            <CurrencySelect value={currency} onChange={setCurrencyOverride} />
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Remove line"
                style={{ flex: "0 0 auto" }}
                onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
        ))}
        <div className="action-bar">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={<Plus className="size-4" />}
            onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
          >
            Add line
          </Button>
          <span className="muted">
            Total: {currency} {(totalCents / 100).toFixed(2)}
          </span>
        </div>

        {/* PRD-003: "the console warns (warn only — do not block)". Nothing
            here disables the submit button, and the API rejects nothing on
            credit grounds either. */}
        {creditWarning && (
          <p role="status" className="mt-2 text-sm text-warn">
            {creditWarning}
          </p>
        )}

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
            {mutation.isPending ? "Creating…" : "Create invoice"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
