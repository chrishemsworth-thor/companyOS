import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { CurrencySelect } from "../CurrencySelect";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useBaseCurrency } from "../../hooks/useBaseCurrency";
import { parseAmountToCents } from "../../lib/money";
import type { Contact, Customer, Deal, Lead } from "../../api/types";

interface ConvertBody {
  deal?: { title: string; value_cents: number; currency: string };
}

export interface LeadConvertResult {
  lead: Lead;
  customer: Customer;
  contact: Contact | null;
  deal: Deal | null;
}

/** Convert a lead into a customer (+ optional deal). */
export function LeadConvertModal({
  lead,
  onClose,
  onConverted,
}: {
  lead: Lead;
  onClose: () => void;
  onConverted?: (result: LeadConvertResult) => void;
}) {
  const [withDeal, setWithDeal] = useState(true);
  const [title, setTitle] = useState(lead.company ?? lead.name);
  const [value, setValue] = useState("");
  // Defaults to the company base currency until the user picks one explicitly.
  const baseCurrency = useBaseCurrency();
  const [currencyOverride, setCurrencyOverride] = useState<string | null>(null);
  const currency = currencyOverride ?? baseCurrency;
  const [validationError, setValidationError] = useState<string | null>(null);

  const mutation = useApiMutation({
    mutationFn: (client, body: ConvertBody) =>
      client.post<LeadConvertResult>(`/v1/leads/${lead.lead_id}/convert`, body),
    invalidates: () => [["leads"], ["lead", lead.lead_id], ["customers"], ["deals"]],
    successMessage: "Lead converted",
    onSuccess: (result) => {
      onClose();
      onConverted?.(result);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    if (!withDeal) {
      mutation.mutate({});
      return;
    }
    const value_cents = parseAmountToCents(value);
    if (value_cents === null) {
      setValidationError("Enter a valid deal value.");
      return;
    }
    mutation.mutate({ deal: { title: title.trim(), value_cents, currency } });
  };

  return (
    <Modal title="Convert lead" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="text-sm text-muted">
          Creates customer <strong>{lead.company ?? lead.name}</strong>
          {lead.company ? (
            <>
              {" "}
              with <strong>{lead.name}</strong> as its primary contact
            </>
          ) : null}
          .
        </p>
        <FormRow label="">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={withDeal}
              onChange={(e) => setWithDeal(e.target.checked)}
            />
            Create a deal
          </label>
        </FormRow>
        {withDeal && (
          <>
            <FormRow label="Deal title">
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
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
                <CurrencySelect value={currency} onChange={setCurrencyOverride} />
              </FormRow>
            </div>
          </>
        )}
        <FormError error={validationError ?? mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Converting…" : "Convert lead"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
