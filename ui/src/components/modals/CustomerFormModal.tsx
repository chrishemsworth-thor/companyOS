import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";
import type { Customer } from "../../api/types";

type Body = Record<string, string | number | null | undefined>;

/** Blank string => omit; the API treats a missing key as "leave it alone". */
const text = (v: string) => (v.trim() === "" ? undefined : v.trim());

/**
 * Blank => null, which the API reads as "unset" for a nullable column. That
 * matters for `payment_terms_days`, where null means "use the tenant default"
 * and 0 means "due on issue" — they are different answers, and clearing the
 * field must produce the first, not the second.
 */
const nullableNumber = (v: string) => (v.trim() === "" ? null : Number(v));

/** Create a customer, or edit one when `existing` is passed. */
export function CustomerFormModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Customer;
  onClose: () => void;
  onSaved?: (customer: Customer) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? "");
  // PRD-003 commercial attributes.
  const [industry, setIndustry] = useState(existing?.industry ?? "");
  const [website, setWebsite] = useState(existing?.website ?? "");
  const [regNo, setRegNo] = useState(existing?.reg_no ?? "");
  const [taxNo, setTaxNo] = useState(existing?.tax_no ?? "");
  const [paymentTerms, setPaymentTerms] = useState(
    existing?.payment_terms_days === null || existing?.payment_terms_days === undefined
      ? ""
      : String(existing.payment_terms_days),
  );
  const [creditLimit, setCreditLimit] = useState(
    existing?.credit_limit_cents === null || existing?.credit_limit_cents === undefined
      ? ""
      : String(existing.credit_limit_cents / 100),
  );
  const [preferredChannel, setPreferredChannel] = useState<"" | "email" | "whatsapp">(
    existing?.preferred_channel ?? "",
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [shipLine1, setShipLine1] = useState(existing?.ship_address_line1 ?? "");
  const [shipCity, setShipCity] = useState(existing?.ship_city ?? "");
  const [shipState, setShipState] = useState(existing?.ship_state ?? "");
  const [shipPostcode, setShipPostcode] = useState(existing?.ship_postcode ?? "");

  const mutation = useApiMutation({
    mutationFn: (client, body: Body) =>
      existing
        ? client.patch<Customer>(`/v1/customers/${existing.customer_id}`, body)
        : client.post<Customer>("/v1/customers", body),
    invalidates: () =>
      existing ? [["customers"], ["customer", existing.customer_id]] : [["customers"]],
    onSuccess: (customer) => {
      onClose();
      onSaved?.(customer);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const credit = creditLimit.trim();
    mutation.mutate({
      name: name.trim(),
      email: text(email),
      phone: text(phone),
      industry: text(industry),
      website: text(website),
      reg_no: text(regNo),
      tax_no: text(taxNo),
      payment_terms_days: nullableNumber(paymentTerms),
      // Entered in currency units, stored in cents like every other money
      // field in the codebase.
      credit_limit_cents: credit === "" ? null : Math.round(Number(credit) * 100),
      preferred_channel: preferredChannel === "" ? null : preferredChannel,
      notes: text(notes),
      ship_address_line1: text(shipLine1),
      ship_city: text(shipCity),
      ship_state: text(shipState),
      ship_postcode: text(shipPostcode),
    });
  };

  return (
    <Modal title={existing ? "Edit customer" : "New customer"} onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </FormRow>
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

        <h3 className="mt-4 text-sm font-semibold">Commercial</h3>
        <FormRow label="Registration no. (SSM)">
          <input className="input" value={regNo} onChange={(e) => setRegNo(e.target.value)} />
        </FormRow>
        <FormRow label="Tax / SST no.">
          <input className="input" value={taxNo} onChange={(e) => setTaxNo(e.target.value)} />
        </FormRow>
        <FormRow label="Industry">
          <input className="input" value={industry} onChange={(e) => setIndustry(e.target.value)} />
        </FormRow>
        <FormRow label="Website">
          <input className="input" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </FormRow>
        <FormRow label="Payment terms (days)">
          <input
            className="input"
            type="number"
            min={0}
            max={365}
            placeholder="Company default"
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
          />
        </FormRow>
        <p className="mb-3 text-xs text-muted">
          Invoices for this customer with no explicit due date fall due this many days after issue.
          Leave blank to use the company default.
        </p>
        <FormRow label="Credit limit">
          <input
            className="input"
            type="number"
            min={0}
            step="0.01"
            placeholder="No limit"
            value={creditLimit}
            onChange={(e) => setCreditLimit(e.target.value)}
          />
        </FormRow>
        <FormRow label="Preferred channel">
          <select
            className="input"
            value={preferredChannel}
            onChange={(e) => setPreferredChannel(e.target.value as "" | "email" | "whatsapp")}
          >
            <option value="">Not set</option>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
        </FormRow>

        <h3 className="mt-4 text-sm font-semibold">Shipping address</h3>
        <FormRow label="Address line 1">
          <input
            className="input"
            value={shipLine1}
            onChange={(e) => setShipLine1(e.target.value)}
          />
        </FormRow>
        <div className="form-row-inline">
          <FormRow label="City">
            <input className="input" value={shipCity} onChange={(e) => setShipCity(e.target.value)} />
          </FormRow>
          <FormRow label="State">
            <input
              className="input"
              value={shipState}
              onChange={(e) => setShipState(e.target.value)}
            />
          </FormRow>
          <FormRow label="Postcode">
            <input
              className="input"
              value={shipPostcode}
              onChange={(e) => setShipPostcode(e.target.value)}
            />
          </FormRow>
        </div>

        <FormRow label="Notes">
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
            {mutation.isPending ? "Saving…" : existing ? "Save changes" : "Create customer"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
