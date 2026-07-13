import { useQuery } from "@tanstack/react-query";
import { Modal } from "../Modal";
import { FormError } from "../FormError";
import { LoadingState } from "../AsyncState";
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
        <div>
          <div className="detail-grid">
            <div>
              <span className="muted">Date</span>
              <div>{entry.entry_date}</div>
            </div>
            <div>
              <span className="muted">Source</span>
              <div>{entry.source_type}</div>
            </div>
            <div>
              <span className="muted">Currency</span>
              <div>{entry.currency}</div>
            </div>
          </div>
          {entry.memo && <p className="muted">{entry.memo}</p>}
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
          <FormError error={reverse.error} />
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={reverse.isPending || isReversal}
              title={isReversal ? "A reversal can't be reversed" : undefined}
              onClick={() => reverse.mutate()}
            >
              {reverse.isPending ? "Reversing…" : "Reverse entry"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
