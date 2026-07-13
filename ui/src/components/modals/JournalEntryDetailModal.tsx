import { useQuery } from "@tanstack/react-query";
import { Modal } from "../Modal";
import { FormError } from "../FormError";
import { LoadingState } from "../AsyncState";
import { Field } from "../Field";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useAuth } from "../../auth/AuthContext";
import { useApiMutation } from "../../hooks/useApiMutation";
import { formatCents } from "../../lib/format";
import type { Account, JournalEntry } from "../../api/types";

/**
 * View a journal entry's lines and, since the ledger is append-only, post a
 * reversal (never an edit). Reversals are disabled for entries that are
 * themselves reversals.
 */
export function JournalEntryDetailModal({
  entryId,
  accounts,
  onClose,
}: {
  entryId: string;
  accounts: Account[];
  onClose: () => void;
}) {
  const { client } = useAuth();
  const accountLabel = (id: string) => {
    const a = accounts.find((x) => x.account_id === id);
    return a ? `${a.code} ${a.name}` : id;
  };

  const query = useQuery({
    queryKey: ["ledger", "entry", entryId],
    queryFn: () => client!.get<JournalEntry>(`/v1/ledger/entries/${entryId}`),
    enabled: !!client,
  });

  const reverse = useApiMutation({
    mutationFn: (c, _vars: void) => c.post(`/v1/ledger/entries/${entryId}/reverse`),
    invalidates: () => [["ledger", "entries"], ["ledger"]],
    onSuccess: onClose,
  });

  const entry = query.data;
  const isReversal = entry?.source_type === "reversal";

  return (
    <Modal title="Journal entry" onClose={onClose}>
      {query.isLoading && <LoadingState />}
      {entry && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-4 rounded-lg border border-border bg-surface-2 p-4">
            <Field label="Date">{entry.entry_date}</Field>
            <Field label="Source">
              <span className="capitalize">{entry.source_type}</span>
            </Field>
            <Field label="Currency">{entry.currency}</Field>
          </div>
          {entry.memo && <p className="muted">{entry.memo}</p>}
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th style={{ textAlign: "right" }}>Debit</th>
                  <th style={{ textAlign: "right" }}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.map((l) => (
                  <tr key={l.line_no}>
                    <td>{accountLabel(l.account_id)}</td>
                    <td style={{ textAlign: "right" }}>
                      {l.amount_cents > 0 ? formatCents(l.amount_cents) : ""}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {l.amount_cents < 0 ? formatCents(-l.amount_cents) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <FormError error={reverse.error} />
          <ModalActions>
            <Button type="button" onClick={onClose}>
              Close
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={reverse.isPending}
              disabled={reverse.isPending || isReversal}
              title={isReversal ? "A reversal can't be reversed" : undefined}
              onClick={() => reverse.mutate()}
            >
              {reverse.isPending ? "Reversing…" : "Reverse entry"}
            </Button>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}
