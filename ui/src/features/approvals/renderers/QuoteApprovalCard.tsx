import { useQuery } from "@tanstack/react-query";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useAuth } from "../../../auth/AuthContext";
import { formatDate, formatMoney } from "../../../lib/format";
import type { QuoteDetail } from "../../../api/types";
import type { ApprovalRendererProps } from "./types";

/**
 * The `quote` context card (PRD-004 P1, plugged into PRD-007's registry).
 *
 * The approver's story is *"quotes above a threshold need my approval before
 * sending, so that junior staff cannot commit the company to bad pricing"* — so
 * the card answers the pricing question directly: what the total is, what was
 * discounted off it, how long it stands, and what is actually being sold.
 *
 * The discount is given its own line rather than being left implicit in the
 * subtotal. A quote is escalated because of its *value*, and "we are giving away
 * 22% of this" is the fact most likely to change the answer — burying it in a
 * per-line column would mean the approver has to do the arithmetic.
 *
 * Fetches its own subject, as `ApprovalRendererProps` intends: the inbox shell
 * knows nothing about quotes, which is what keeps "adding a new approvable type
 * costs one renderer file" true.
 */

/** Discount as a share of what the work would have cost undiscounted. */
function discountShare(quote: QuoteDetail): number | null {
  const gross = quote.subtotal_cents + quote.discount_total_cents;
  if (quote.discount_total_cents <= 0 || gross <= 0) return null;
  return Math.round((quote.discount_total_cents / gross) * 100);
}

export function QuoteApprovalCard({ approval }: ApprovalRendererProps) {
  const { client } = useAuth();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["quote", approval.subject_id],
    queryFn: () => client!.get<QuoteDetail>(`/v1/quotes/${approval.subject_id}`),
    enabled: !!client,
  });

  if (isLoading) {
    return <div className="text-sm text-subtle">Loading quote details…</div>;
  }

  // PRD-007's criterion that a subject which has gone away "renders as
  // unavailable rather than erroring".
  if (isError || !data) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
        <span>
          This quote is no longer available. Reference{" "}
          <span className="font-mono">{approval.subject_id}</span>.
        </span>
      </div>
    );
  }

  const money = (cents: number) => formatMoney(cents, data.currency);
  const share = discountShare(data);

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-subtle">Quote</dt>
        <dd className="font-mono text-fg">{data.quote_number}</dd>

        <dt className="text-subtle">Total</dt>
        <dd className="font-medium text-fg">{money(data.grand_total_cents)}</dd>

        <dt className="text-subtle">Subtotal</dt>
        <dd className="text-fg">{money(data.subtotal_cents)}</dd>

        {data.tax_cents > 0 && (
          <>
            <dt className="text-subtle">Tax</dt>
            <dd className="text-fg">{money(data.tax_cents)}</dd>
          </>
        )}

        <dt className="text-subtle">Valid until</dt>
        <dd className="text-fg">
          {data.expiry_date ? formatDate(data.expiry_date) : "No expiry set"}
        </dd>
      </dl>

      {data.discount_total_cents > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
          <span>
            Discounted by {money(data.discount_total_cents)}
            {share !== null && ` (${share}% off list)`}.
          </span>
        </div>
      )}

      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-subtle">
          {data.lines.length} {data.lines.length === 1 ? "line" : "lines"}
        </div>
        <table className="w-full text-sm">
          <tbody>
            {data.lines.map((line) => (
              <tr key={line.line_no} className="border-b border-border last:border-0">
                <td className="py-1 pr-2">
                  <div className="text-fg">{line.item_name}</div>
                  {line.description && (
                    <div className="text-xs text-subtle">{line.description}</div>
                  )}
                </td>
                <td className="whitespace-nowrap py-1 pr-2 text-right text-xs text-subtle">
                  {line.quantity}
                  {line.unit ? ` ${line.unit}` : ""} × {money(line.unit_cents)}
                </td>
                <td className="whitespace-nowrap py-1 text-right text-fg">
                  {money(line.line_total_cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.notes && <p className="whitespace-pre-wrap text-xs text-muted">{data.notes}</p>}
    </div>
  );
}
