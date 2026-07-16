import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { FormError } from "../../components/FormError";
import { useApiMutation } from "../../hooks/useApiMutation";
import { formatMoney, formatDate } from "../../lib/format";
import type { Quote, QuoteDetail as QuoteDetailType } from "../../api/types";

export function QuoteDetail() {
  const { id } = useParams<{ id: string }>();
  const { client, baseUrl } = useAuth();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ["quote", id],
    queryFn: () => client!.get<QuoteDetailType>(`/v1/quotes/${id}`),
    enabled: !!client && !!id,
  });

  const sendMutation = useApiMutation({
    mutationFn: (apiClient, quoteId: string) => apiClient.post<Quote>(`/v1/quotes/${quoteId}/send`),
    invalidates: (quoteId) => [["quote", quoteId], ["quotes"]],
  });
  const acceptMutation = useApiMutation({
    mutationFn: (apiClient, quoteId: string) => apiClient.post<Quote>(`/v1/quotes/${quoteId}/accept`),
    invalidates: (quoteId) => [["quote", quoteId], ["quotes"]],
  });
  const rejectMutation = useApiMutation({
    mutationFn: (apiClient, quoteId: string) => apiClient.post<Quote>(`/v1/quotes/${quoteId}/reject`),
    invalidates: (quoteId) => [["quote", quoteId], ["quotes"]],
  });
  const convertMutation = useApiMutation({
    mutationFn: (apiClient, quoteId: string) =>
      apiClient.post<{ quote: Quote; invoice_id: string }>(`/v1/quotes/${quoteId}/convert`, {}),
    invalidates: (quoteId) => [["quote", quoteId], ["quotes"], ["invoices"]],
    successMessage: "Quote converted to invoice",
    onSuccess: (data) => navigate(`/invoices/${data.invoice_id}`),
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;
  const quote = query.data;
  if (!quote) return null;

  const documentUrl = `${baseUrl}/v1/quotes/${quote.quote_id}/document`;
  const currency = quote.currency;
  const showDiscount = quote.discount_total_cents > 0;
  const busy =
    sendMutation.isPending ||
    acceptMutation.isPending ||
    rejectMutation.isPending ||
    convertMutation.isPending;

  return (
    <div>
      <BackLink to="/quotes">Quotes</BackLink>
      <PageHeader title={<span className="font-mono">{quote.quote_number}</span>}>
        <a href={documentUrl} target="_blank" rel="noreferrer">
          <Button icon={<FileText className="size-4" />}>View document</Button>
        </a>
        {quote.status === "draft" && (
          <Button variant="primary" onClick={() => sendMutation.mutate(quote.quote_id)} loading={sendMutation.isPending}>
            Send quote
          </Button>
        )}
        {quote.status === "sent" && (
          <>
            <Button variant="primary" onClick={() => acceptMutation.mutate(quote.quote_id)} loading={acceptMutation.isPending}>
              Mark accepted
            </Button>
            <Button variant="danger" onClick={() => rejectMutation.mutate(quote.quote_id)} loading={rejectMutation.isPending}>
              Mark rejected
            </Button>
          </>
        )}
        {quote.status === "accepted" && (
          <Button variant="primary" onClick={() => convertMutation.mutate(quote.quote_id)} loading={convertMutation.isPending}>
            Convert to invoice
          </Button>
        )}
        <StatusBadge status={quote.status} />
      </PageHeader>
      <FormError
        error={
          sendMutation.error ?? acceptMutation.error ?? rejectMutation.error ?? convertMutation.error
        }
      />

      <DetailGrid>
        <Field label="Customer">
          <Link to={`/customers/${quote.customer_id}`} className="font-mono">
            {quote.customer_id}
          </Link>
        </Field>
        <Field label="Subtotal">{formatMoney(quote.subtotal_cents, currency)}</Field>
        {showDiscount && <Field label="Discount">{formatMoney(quote.discount_total_cents, currency)}</Field>}
        {quote.tax_cents > 0 && (
          <Field label={`Tax (${(quote.tax_rate_bps / 100).toFixed(0)}%)`}>
            {formatMoney(quote.tax_cents, currency)}
          </Field>
        )}
        <Field label="Total">{formatMoney(quote.grand_total_cents, currency)}</Field>
        <Field label="Issued">{quote.issue_date}</Field>
        <Field label="Valid until">{quote.expiry_date ?? "—"}</Field>
        <Field label="Sent">{formatDate(quote.sent_at)}</Field>
        <Field label="Accepted">{formatDate(quote.accepted_at)}</Field>
        {quote.converted_invoice_id && (
          <Field label="Invoice">
            <Link to={`/invoices/${quote.converted_invoice_id}`} className="font-mono">
              {quote.converted_invoice_id}
            </Link>
          </Field>
        )}
      </DetailGrid>

      <h2>Line items</h2>
      <DataTable
        rows={quote.lines}
        rowKey={(l) => String(l.line_no)}
        columns={[
          { header: "#", render: (l) => l.line_no },
          {
            header: "Item",
            render: (l) => (
              <div>
                <div className="font-semibold">{l.item_name}</div>
                {l.description && <div className="text-muted text-[0.85em]">{l.description}</div>}
                {l.note && <div className="text-subtle text-[0.8em] italic">{l.note}</div>}
              </div>
            ),
          },
          { header: "Qty", render: (l) => `${l.quantity}${l.unit ? ` ${l.unit}` : ""}`, align: "right" },
          { header: "Unit price", render: (l) => formatMoney(l.unit_cents, currency), align: "right" },
          ...(showDiscount
            ? [{ header: "Discount", render: (l: (typeof quote.lines)[number]) => formatMoney(l.discount_cents, currency), align: "right" as const }]
            : []),
          { header: "Amount", render: (l) => formatMoney(l.line_total_cents, currency), align: "right" },
        ]}
      />

      {quote.notes && (
        <>
          <h2>Notes</h2>
          <p className="whitespace-pre-wrap text-sm">{quote.notes}</p>
        </>
      )}

      <p className="mt-4 text-sm text-muted">
        Tip: open <strong>View document</strong> and use your browser's Print → Save as PDF to export a
        branded copy. Adjust the look in <Link to="/settings/quote-branding">Quote Branding</Link>.
      </p>
      {busy && <span className="sr-only">Working…</span>}
    </div>
  );
}
