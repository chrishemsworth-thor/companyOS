import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, FileText, Link2, ShieldCheck } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { CanWrite } from "../../components/CanWrite";
import { DataTable } from "../../components/DataTable";
import { FormError } from "../../components/FormError";
import { useApiMutation } from "../../hooks/useApiMutation";
import { formatMoney, formatDate } from "../../lib/format";
import type {
  MintedQuoteLink,
  Quote,
  QuoteAcceptances,
  QuoteDetail as QuoteDetailType,
  QuoteLinkInfo,
} from "../../api/types";

/** Statuses from which a customer link exists or can be created. Mirrors the server. */
const LINKABLE: string[] = ["sent", "accepted", "rejected", "expired", "converted"];

export function QuoteDetail() {
  const { id } = useParams<{ id: string }>();
  const { client, baseUrl } = useAuth();
  const navigate = useNavigate();
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
  const versionMutation = useApiMutation({
    mutationFn: (apiClient, quoteId: string) =>
      apiClient.post<QuoteDetailType>(`/v1/quotes/${quoteId}/version`),
    invalidates: () => [["quotes"]],
    successMessage: "New version created",
    onSuccess: (created) => navigate(`/quotes/${created.quote_id}`),
  });
  const convertMutation = useApiMutation({
    mutationFn: (apiClient, quoteId: string) =>
      apiClient.post<{ quote: Quote; invoice_id: string }>(`/v1/quotes/${quoteId}/convert`, {}),
    invalidates: (quoteId) => [["quote", quoteId], ["quotes"], ["invoices"]],
    successMessage: "Quote converted to invoice",
    onSuccess: (data) => navigate(`/invoices/${data.invoice_id}`),
  });

  // The live link and the acceptance record. Both 404 in the ordinary case
  // (no link minted, nobody has signed), so neither retries — a 404 here is an
  // answer, not a failure.
  const linkQuery = useQuery({
    queryKey: ["quote-link", id],
    queryFn: () => client!.get<QuoteLinkInfo>(`/v1/quotes/${id}/link`),
    enabled: !!client && !!id,
    retry: false,
  });
  const acceptanceQuery = useQuery({
    queryKey: ["quote-acceptances", id],
    queryFn: () => client!.get<QuoteAcceptances>(`/v1/quotes/${id}/acceptances`),
    enabled: !!client && !!id,
    retry: false,
  });

  const mintMutation = useApiMutation({
    mutationFn: (apiClient, quoteId: string) =>
      apiClient.post<MintedQuoteLink>(`/v1/quotes/${quoteId}/link`),
    invalidates: (quoteId) => [["quote-link", quoteId]],
    // The token exists in this response and nowhere else — it is stored hashed
    // — so it is held in component state to be copied, and is gone on reload.
    onSuccess: (minted) => setMintedUrl(minted.url),
  });
  const revokeMutation = useApiMutation({
    mutationFn: (apiClient, quoteId: string) => apiClient.delete(`/v1/quotes/${quoteId}/link`),
    invalidates: (quoteId) => [["quote-link", quoteId]],
    successMessage: "Link revoked",
    onSuccess: () => setMintedUrl(null),
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;
  const quote = query.data;
  if (!quote) return null;

  const documentUrl = `${baseUrl}/v1/quotes/${quote.quote_id}/document`;
  // The most recent response the customer gave. There can be more than one row
  // (PRD-004 keeps one per signatory so counter-signing stays additive), and
  // the operative acceptance is named on the quote itself.
  const acceptances = acceptanceQuery.data?.acceptances ?? [];
  const acceptance =
    acceptances.find((a) => a.acceptance_id === quote.accepted_acceptance_id) ??
    acceptances[acceptances.length - 1];
  const currency = quote.currency;
  const showDiscount = quote.discount_total_cents > 0;
  const busy =
    sendMutation.isPending ||
    acceptMutation.isPending ||
    rejectMutation.isPending ||
    convertMutation.isPending ||
    versionMutation.isPending;

  return (
    <div>
      <BackLink to="/quotes">Quotes</BackLink>
      <PageHeader title={<span className="font-mono">{quote.quote_number}</span>}>
        <a href={documentUrl} target="_blank" rel="noreferrer">
          <Button icon={<FileText className="size-4" />}>View document</Button>
        </a>
        {quote.accepted_acceptance_id && (
          <a href={`${baseUrl}/v1/quotes/${quote.quote_id}/artifact`} target="_blank" rel="noreferrer">
            <Button icon={<ShieldCheck className="size-4" />}>Signed copy</Button>
          </a>
        )}
        <CanWrite module="crm">
          {quote.status === "draft" && (
            <Button variant="primary" onClick={() => sendMutation.mutate(quote.quote_id)} loading={sendMutation.isPending}>
              Send quote
            </Button>
          )}
          {/* PRD-004's immutability rule, as a control rather than an error: a
              quote past draft cannot be edited, so the way to change it is a
              new version. Offering the button beats letting the user discover
              the 409. */}
          {quote.status !== "draft" && !quote.superseded_by_quote_id && (
            <Button onClick={() => versionMutation.mutate(quote.quote_id)} loading={versionMutation.isPending}>
              New version
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
        </CanWrite>
        {/* Converting a quote writes an invoice, so it needs finance, not CRM. */}
        <CanWrite module="finance">
          {quote.status === "accepted" && (
            <Button variant="primary" onClick={() => convertMutation.mutate(quote.quote_id)} loading={convertMutation.isPending}>
              Convert to invoice
            </Button>
          )}
        </CanWrite>
        <StatusBadge status={quote.status} />
      </PageHeader>
      <FormError
        error={
          sendMutation.error ??
          acceptMutation.error ??
          rejectMutation.error ??
          convertMutation.error ??
          versionMutation.error ??
          mintMutation.error ??
          revokeMutation.error
        }
      />

      {quote.status === "pending_approval" && (
        <div className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
          This quote is over the approval threshold and is waiting on an admin or finance user. It
          cannot be sent or shared with the customer until they decide.
        </div>
      )}
      {quote.status === "draft" && quote.sign_off_comment && (
        <div className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
          <strong>Approval was declined:</strong> {quote.sign_off_comment}
        </div>
      )}

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
        <Field label="Version">{quote.version}</Field>
        {quote.supersedes_quote_id && (
          <Field label="Replaces">
            <Link to={`/quotes/${quote.supersedes_quote_id}`} className="font-mono">
              {quote.supersedes_quote_id}
            </Link>
          </Field>
        )}
        {quote.superseded_by_quote_id && (
          <Field label="Replaced by">
            <Link to={`/quotes/${quote.superseded_by_quote_id}`} className="font-mono">
              {quote.superseded_by_quote_id}
            </Link>
          </Field>
        )}
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

      <h2>Customer link</h2>
      {LINKABLE.includes(quote.status) ? (
        <div className="mb-4 flex flex-col gap-2">
          {mintedUrl && (
            <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
              <div className="mb-1 text-xs text-subtle">
                Copy this now — it is shown once and cannot be retrieved again.
              </div>
              <div className="flex items-center gap-2">
                <code className="grow break-all text-xs">{mintedUrl}</code>
                <Button
                  icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  onClick={() => {
                    void navigator.clipboard?.writeText(mintedUrl);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
          <DetailGrid>
            <Field label="Status">
              {linkQuery.data ? "Active" : "No active link"}
            </Field>
            {linkQuery.data?.expires_at && (
              <Field label="Link expires">{formatDate(linkQuery.data.expires_at)}</Field>
            )}
            <Field label="First opened">{formatDate(quote.first_viewed_at)}</Field>
            <Field label="Last opened">{formatDate(quote.last_viewed_at)}</Field>
            <Field label="Times opened">{quote.view_count}</Field>
          </DetailGrid>
          <CanWrite module="crm">
            <div className="flex gap-2">
              <Button
                icon={<Link2 className="size-4" />}
                onClick={() => mintMutation.mutate(quote.quote_id)}
                loading={mintMutation.isPending}
              >
                {linkQuery.data ? "Replace link" : "Create link"}
              </Button>
              {linkQuery.data && (
                <Button
                  variant="danger"
                  onClick={() => revokeMutation.mutate(quote.quote_id)}
                  loading={revokeMutation.isPending}
                >
                  Revoke
                </Button>
              )}
            </div>
          </CanWrite>
          <p className="text-sm text-muted">
            The customer opens this without logging in, and can accept or decline it there. Creating
            a new link revokes the previous one.
          </p>
        </div>
      ) : (
        <p className="mb-4 text-sm text-muted">
          A customer link becomes available once the quote has been sent.
        </p>
      )}

      {acceptance && (
        <>
          <h2>Acceptance record</h2>
          <DetailGrid>
            <Field label="Decision">{acceptance.decision}</Field>
            <Field label="Signatory">{acceptance.signatory_name}</Field>
            <Field label="Email">{acceptance.signatory_email}</Field>
            <Field label="When (UTC)">{acceptance.created_at}</Field>
            <Field label="IP address">{acceptance.ip_address ?? "—"}</Field>
            <Field label="Known contact">
              {acceptance.contact_id ? (
                <span>
                  Matched by {acceptance.contact_match}
                </span>
              ) : (
                "Not a recorded contact"
              )}
            </Field>
            {acceptance.decline_reason && (
              <Field label="Reason">{acceptance.decline_reason}</Field>
            )}
            {acceptance.document_sha256 && (
              <Field label="Document hash (SHA-256)">
                <span className="break-all font-mono text-xs">{acceptance.document_sha256}</span>
              </Field>
            )}
            <Field label="Agreement">{acceptance.agreement_version}</Field>
          </DetailGrid>
          {acceptance.document_sha256 && (
            <p className="mb-4 text-sm text-muted">
              <strong>Signed copy</strong> above opens the exact document that was accepted. It is
              stored unchanged and does not follow later branding changes — the hash proves it.
            </p>
          )}
        </>
      )}

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
