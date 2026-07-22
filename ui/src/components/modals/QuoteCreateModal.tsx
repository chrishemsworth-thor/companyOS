import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { CustomerSelect } from "../CustomerSelect";
import { ContactSelect } from "../ContactSelect";
import { ContactFormModal } from "./ContactFormModal";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";
import { parseAmountToCents } from "../../lib/money";
import type { Quote } from "../../api/types";

interface LineDraft {
  item_name: string;
  description: string;
  quantity: string;
  unit_cents: string;
  discount_cents: string;
}

const emptyLine = (): LineDraft => ({
  item_name: "",
  description: "",
  quantity: "1",
  unit_cents: "",
  discount_cents: "",
});

interface CreateQuoteBody {
  customer_id: string;
  contact_id?: string;
  issue_date?: string;
  expiry_date?: string;
  notes?: string;
  lines: {
    item_name: string;
    description?: string;
    quantity: number;
    unit_cents: number;
    discount_cents?: number;
  }[];
}

export function QuoteCreateModal({
  defaultCustomerId,
  onClose,
  onCreated,
}: {
  defaultCustomerId?: string;
  onClose: () => void;
  onCreated?: (quote: Quote) => void;
}) {
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? "");
  const [contactId, setContactId] = useState("");
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [expiryDate, setExpiryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [addingContact, setAddingContact] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const updateLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const mutation = useApiMutation({
    mutationFn: (client, body: CreateQuoteBody) => client.post<Quote>("/v1/quotes", body),
    invalidates: (vars) => [["quotes"], ["customer", vars.customer_id]],
    successMessage: "Quote created",
    onSuccess: (quote) => {
      onClose();
      onCreated?.(quote);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    if (!customerId) {
      setValidationError("Select a customer.");
      return;
    }
    const parsedLines: CreateQuoteBody["lines"] = [];
    for (const [i, l] of lines.entries()) {
      if (!l.item_name.trim()) {
        setValidationError(`Line ${i + 1}: item name is required.`);
        return;
      }
      const unitCents = parseAmountToCents(l.unit_cents);
      if (unitCents === null) {
        setValidationError(`Line ${i + 1}: enter a valid unit price.`);
        return;
      }
      const qty = Number(l.quantity);
      if (!Number.isInteger(qty) || qty <= 0) {
        setValidationError(`Line ${i + 1}: quantity must be a positive whole number.`);
        return;
      }
      let discountCents = 0;
      if (l.discount_cents.trim()) {
        const parsed = parseAmountToCents(l.discount_cents);
        if (parsed === null) {
          setValidationError(`Line ${i + 1}: enter a valid discount.`);
          return;
        }
        discountCents = parsed;
      }
      parsedLines.push({
        item_name: l.item_name.trim(),
        ...(l.description.trim() ? { description: l.description.trim() } : {}),
        quantity: qty,
        unit_cents: unitCents,
        ...(discountCents ? { discount_cents: discountCents } : {}),
      });
    }

    mutation.mutate({
      customer_id: customerId,
      ...(contactId ? { contact_id: contactId } : {}),
      ...(issueDate ? { issue_date: issueDate } : {}),
      ...(expiryDate ? { expiry_date: expiryDate } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      lines: parsedLines,
    });
  };

  // Swap dialogs while adding a contact (Modal doesn't portal, so nesting one
  // inside this form would nest <form>s). This component stays mounted, so the
  // draft quote state is intact when the contact dialog closes.
  if (addingContact && customerId) {
    return (
      <ContactFormModal
        customerId={customerId}
        onClose={() => setAddingContact(false)}
        onSaved={(contact) => setContactId(contact.contact_id)}
      />
    );
  }

  return (
    <Modal title="New quote" onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Customer">
          <CustomerSelect
            value={customerId}
            onChange={(id) => {
              setCustomerId(id);
              setContactId("");
            }}
            disabled={!!defaultCustomerId}
          />
        </FormRow>
        <FormRow label="Contact (optional)">
          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ flex: 1 }}>
              <ContactSelect customerId={customerId} value={contactId} onChange={setContactId} />
            </div>
            <Button
              type="button"
              variant="ghost"
              icon={<Plus className="size-4" />}
              disabled={!customerId}
              onClick={() => setAddingContact(true)}
            >
              New contact
            </Button>
          </div>
        </FormRow>
        <div className="form-row-inline">
          <FormRow label="Issue date">
            <input
              className="input"
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
            />
          </FormRow>
          <FormRow label="Valid until (optional)">
            <input
              className="input"
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          </FormRow>
        </div>

        <div className="field-label" style={{ marginTop: 8 }}>
          Line items
        </div>
        {lines.map((line, i) => (
          <div
            key={i}
            className="rounded-lg border border-border p-3"
            style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 6 }}
          >
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input"
                placeholder="Item name"
                value={line.item_name}
                onChange={(e) => updateLine(i, { item_name: e.target.value })}
                style={{ flex: 2 }}
                required
              />
              {lines.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  aria-label="Remove line"
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
            <input
              className="input"
              placeholder="Description (optional)"
              value={line.description}
              onChange={(e) => updateLine(i, { description: e.target.value })}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input"
                inputMode="numeric"
                placeholder="Qty"
                value={line.quantity}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
                style={{ flex: 1 }}
                required
              />
              <input
                className="input"
                inputMode="decimal"
                placeholder="Unit price"
                value={line.unit_cents}
                onChange={(e) => updateLine(i, { unit_cents: e.target.value })}
                style={{ flex: 1 }}
                required
              />
              <input
                className="input"
                inputMode="decimal"
                placeholder="Discount"
                value={line.discount_cents}
                onChange={(e) => updateLine(i, { discount_cents: e.target.value })}
                style={{ flex: 1 }}
              />
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          icon={<Plus className="size-4" />}
          onClick={() => setLines((prev) => [...prev, emptyLine()])}
        >
          Add line
        </Button>

        <FormRow label="Notes (optional)">
          <textarea
            className="input"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
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
            {mutation.isPending ? "Creating…" : "Create quote"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
