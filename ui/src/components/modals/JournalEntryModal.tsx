import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";
import { parseAmountToCents } from "../../lib/money";
import type { Account } from "../../api/types";

interface LineDraft {
  account_id: string;
  side: "debit" | "credit";
  amount: string;
}

const EMPTY_LINE: LineDraft = { account_id: "", side: "debit", amount: "" };

/** Manual journal entry; the ledger rejects unbalanced postings server-side too. */
export function JournalEntryModal({
  accounts,
  onClose,
}: {
  accounts: Account[];
  onClose: () => void;
}) {
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState("MYR");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([
    { ...EMPTY_LINE },
    { ...EMPTY_LINE, side: "credit" },
  ]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const mutation = useApiMutation({
    mutationFn: (
      client,
      body: {
        entry_date: string;
        currency: string;
        memo?: string;
        lines: { account_id: string; amount_cents: number }[];
      },
    ) => client.post("/v1/ledger/entries", body),
    invalidates: () => [["ledger"]],
    onSuccess: onClose,
  });

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const signedCents = (l: LineDraft): number | null => {
    const cents = parseAmountToCents(l.amount);
    if (cents === null || cents === 0) return null;
    return l.side === "debit" ? cents : -cents;
  };

  const balance = lines.reduce((sum, l) => sum + (signedCents(l) ?? 0), 0);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    const parsed = [];
    for (const l of lines) {
      const amount_cents = signedCents(l);
      if (!l.account_id || amount_cents === null) {
        setValidationError("Each line needs an account and a non-zero amount.");
        return;
      }
      parsed.push({ account_id: l.account_id, amount_cents });
    }
    if (parsed.reduce((s, l) => s + l.amount_cents, 0) !== 0) {
      setValidationError("Debits and credits must balance.");
      return;
    }
    mutation.mutate({
      entry_date: entryDate,
      currency,
      ...(memo.trim() ? { memo: memo.trim() } : {}),
      lines: parsed,
    });
  };

  return (
    <Modal title="New journal entry" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-row-inline">
          <FormRow label="Date">
            <input
              className="input"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
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
        <FormRow label="Memo (optional)">
          <input
            className="input"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={500}
          />
        </FormRow>

        <div className="field-label">Lines</div>
        {lines.map((line, i) => (
          <div className="form-row-inline" key={i}>
            <select
              className="input"
              style={{ flex: 2 }}
              value={line.account_id}
              onChange={(e) => setLine(i, { account_id: e.target.value })}
            >
              <option value="" disabled>
                Account
              </option>
              {accounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={line.side}
              onChange={(e) => setLine(i, { side: e.target.value as "debit" | "credit" })}
            >
              <option value="debit">Debit</option>
              <option value="credit">Credit</option>
            </select>
            <input
              className="input"
              placeholder="Amount"
              inputMode="decimal"
              value={line.amount}
              onChange={(e) => setLine(i, { amount: e.target.value })}
            />
            {lines.length > 2 && (
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
            {balance === 0 ? "Balanced" : `Out of balance by ${(balance / 100).toFixed(2)}`}
          </span>
        </div>

        <FormError error={validationError ?? mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Posting…" : "Post entry"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
