import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { useAuth } from "../../auth/AuthContext";
import { useApiMutation } from "../../hooks/useApiMutation";
import { parseAmountToCents, centsToAmountString } from "../../lib/money";
import { formatMoney } from "../../lib/format";
import type { Invoice } from "../../api/types";

const OUTSTANDING: Invoice["status"][] = ["sent", "overdue", "partially_paid"];

/**
 * Record a payment and allocate it across one or more of the customer's
 * outstanding invoices. Defaults to fully settling the invoice it was opened
 * from; other outstanding invoices (same customer + currency) can be paid in
 * the same transaction.
 */
export function PaymentModal({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const { client } = useAuth();
  const [method, setMethod] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  // The customer's outstanding invoices in this currency. The invoices list has
  // no customer filter server-side, so we filter the page client-side.
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => client!.get<{ invoices: Invoice[] }>("/v1/invoices"),
    enabled: !!client,
  });
  const payable = useMemo(() => {
    const all = invoicesQuery.data?.invoices ?? [];
    const set = all.filter(
      (i) =>
        i.customer_id === invoice.customer_id &&
        i.currency === invoice.currency &&
        OUTSTANDING.includes(i.status),
    );
    // Ensure the invoice we opened from is present even if the list is stale.
    if (!set.some((i) => i.invoice_id === invoice.invoice_id)) set.unshift(invoice);
    return set;
  }, [invoicesQuery.data, invoice]);

  // Per-invoice applied amount (string). Seed the opened invoice with its due.
  const [alloc, setAlloc] = useState<Record<string, string>>(() => ({
    [invoice.invoice_id]: centsToAmountString(invoice.amount_due_cents),
  }));

  const totalCents = payable.reduce((sum, i) => {
    const c = parseAmountToCents(alloc[i.invoice_id] ?? "");
    return sum + (c && c > 0 ? c : 0);
  }, 0);

  const mutation = useApiMutation({
    mutationFn: (
      c,
      body: { amount_cents: number; method?: string; applications: { invoice_id: string; applied_cents: number }[] },
    ) =>
      c.post(
        "/v1/payments",
        {
          customer_id: invoice.customer_id,
          amount_cents: body.amount_cents,
          currency: invoice.currency,
          ...(body.method ? { method: body.method } : {}),
          applications: body.applications,
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
    const applications: { invoice_id: string; applied_cents: number }[] = [];
    for (const i of payable) {
      const raw = alloc[i.invoice_id];
      if (!raw || !raw.trim()) continue;
      const cents = parseAmountToCents(raw);
      if (cents === null || cents < 0) {
        setValidationError(`Invalid amount for ${i.invoice_id}.`);
        return;
      }
      if (cents > 0) applications.push({ invoice_id: i.invoice_id, applied_cents: cents });
    }
    if (applications.length === 0) {
      setValidationError("Allocate a positive amount to at least one invoice.");
      return;
    }
    const amount_cents = applications.reduce((s, a) => s + a.applied_cents, 0);
    mutation.mutate({ amount_cents, method: method.trim() || undefined, applications });
  };

  return (
    <Modal title="Record payment" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Allocate the payment across outstanding invoices ({invoice.currency}).</p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Due</th>
              <th style={{ textAlign: "right" }}>Apply</th>
            </tr>
          </thead>
          <tbody>
            {payable.map((i) => (
              <tr key={i.invoice_id}>
                <td>{i.invoice_id}</td>
                <td>{i.status}</td>
                <td style={{ textAlign: "right" }}>{formatMoney(i.amount_due_cents, i.currency)}</td>
                <td style={{ textAlign: "right" }}>
                  <input
                    className="input"
                    inputMode="decimal"
                    style={{ maxWidth: "8rem", textAlign: "right" }}
                    value={alloc[i.invoice_id] ?? ""}
                    onChange={(e) => setAlloc((a) => ({ ...a, [i.invoice_id]: e.target.value }))}
                    placeholder="0.00"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <FormRow label="Method (optional)">
          <input
            className="input"
            placeholder="bank_transfer, cash…"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          />
        </FormRow>
        <p>
          <strong>Total: {formatMoney(totalCents, invoice.currency)}</strong>
        </p>
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
