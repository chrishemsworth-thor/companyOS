import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { DetailGrid } from "../../components/DetailGrid";
import { Field } from "../../components/Field";
import { Badge } from "../../components/Badge";
import { DEPARTMENTS } from "../../lib/departments";
import { formatDate, formatMoney } from "../../lib/format";
import { ReceiptThumbnail } from "../../features/approvals/renderers/ReceiptThumbnail";
import type { ClaimDetail as ClaimDetailType } from "../../api/types";

/**
 * One expense claim, read-only (PRD-006a).
 *
 * **Deliberately read-only.** PRD-006 puts the employee's own claim history and
 * the filing UI in P1; what this screen exists for is the deep link — the
 * approvals inbox and the notification bell both route `expense_claim` here via
 * `subjectRoutes.ts`, and a route with no page behind it lands on the catch-all
 * redirect. So this is the destination for "open the claim", not a place to file
 * one.
 *
 * Visibility is the API's: `GET /v1/claims/:id` answers for the owner, the
 * assigned approver, and anyone with `finance:read`. Everyone else gets a 404,
 * which surfaces here as the standard error state rather than a special case.
 */

function departmentLabel(code: string | null): string | null {
  if (!code) return null;
  return DEPARTMENTS.find((d) => d.id === code)?.label ?? code;
}

export function ClaimDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();

  const query = useQuery({
    queryKey: ["claims", id],
    queryFn: () => client!.get<ClaimDetailType>(`/v1/claims/${id}`),
    enabled: !!client && !!id,
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;
  const data = query.data;
  if (!data) return null;

  const { claim, lines, limit_warnings } = data;
  const money = (cents: number) => formatMoney(cents, claim.currency);
  const department = departmentLabel(claim.department_code);

  return (
    <div>
      {/* Back to the inbox, because that is where every link to this page comes
          from — there is no claims list to return to in this release. */}
      <BackLink to="/approvals">Approvals</BackLink>
      <PageHeader title={<span className="font-mono">{claim.claim_id}</span>}>
        <StatusBadge status={claim.status} />
      </PageHeader>

      <div className="flex flex-col gap-4">
        <DetailGrid>
          <Field label="Total">
            <span className="text-base font-semibold">{money(claim.total_cents)}</span>
          </Field>
          <Field label="Claim date">{claim.claim_date}</Field>
          <Field label="Employee">
            <span className="font-mono text-xs">{claim.employee_id}</span>
          </Field>
          <Field label="Project">
            {claim.project_id ? (
              <span className="font-mono text-xs">{claim.project_id}</span>
            ) : (
              // Named rather than blank, the same principle as PRD-001a's
              // "Unallocated" bucket: untagged is a fact, not a gap.
              <span className="text-subtle">Unallocated</span>
            )}
          </Field>
          <Field label="Department">{department ?? <span className="text-subtle">—</span>}</Field>
          <Field label="Tax recorded">{money(claim.tax_cents)}</Field>
          <Field label="Submitted">{formatDate(claim.submitted_at)}</Field>
          <Field label="Journal entry">
            {claim.entry_id ? (
              // The proof it reached the books, which is the point of the whole
              // feature. Not a link: the ledger view is by entry list, not by id.
              <span className="font-mono text-xs">{claim.entry_id}</span>
            ) : (
              <span className="text-subtle">Not posted</span>
            )}
          </Field>
          {claim.paid_at && (
            <>
              <Field label="Reimbursed">{formatDate(claim.paid_at)}</Field>
              <Field label="Payment reference">
                {claim.payment_reference ?? <span className="text-subtle">—</span>}
              </Field>
            </>
          )}
          {claim.description && <Field label="Note">{claim.description}</Field>}
        </DetailGrid>

        {claim.status === "rejected" && (
          <div className="rounded-xl border border-bad bg-bad-bg px-4 py-3 text-sm text-bad">
            <div className="text-xs font-semibold uppercase tracking-wide">Returned to you</div>
            <p className="mt-1">
              {claim.rejection_comment ?? "No reason was given."}
            </p>
          </div>
        )}

        {limit_warnings.length > 0 && (
          <div className="flex flex-col gap-1 rounded-xl border border-warn bg-warn-bg px-4 py-3 text-sm text-warn">
            {limit_warnings.map((warning) => (
              <div key={warning.category_id} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  <span className="font-semibold">{warning.category_name}</span> is over its{" "}
                  {money(warning.limit_cents)} limit — {money(warning.claimed_cents)} claimed,{" "}
                  {money(warning.over_by_cents)} over.
                </span>
              </div>
            ))}
          </div>
        )}

        <section className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Lines</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {lines.map((line) => {
              const lineDepartment = departmentLabel(
                line.department_code ?? claim.department_code,
              );
              const project = line.project_id ?? claim.project_id;
              return (
                <li
                  key={line.line_no}
                  className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3 sm:flex-row sm:items-start"
                >
                  <div className="w-full sm:w-44 sm:shrink-0">
                    <ReceiptThumbnail
                      claimId={claim.claim_id}
                      lineNo={line.line_no}
                      filename={line.receipt_filename}
                      contentType={line.receipt_content_type}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-fg">{line.category_name}</span>
                      <span className="font-semibold text-fg">{money(line.amount_cents)}</span>
                    </div>
                    {line.description && <p className="text-sm text-muted">{line.description}</p>}
                    {line.category_kind === "mileage" && line.distance_km !== null && (
                      <p className="text-xs text-subtle">{line.distance_km} km</p>
                    )}
                    <div className="flex flex-wrap items-center gap-1 text-xs">
                      <Badge tone="neutral" dot={false}>
                        {line.account_code} {line.account_name}
                      </Badge>
                      {project && (
                        <Badge tone="neutral" dot={false}>
                          {project}
                        </Badge>
                      )}
                      {lineDepartment && (
                        <Badge tone="neutral" dot={false}>
                          {lineDepartment}
                        </Badge>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
