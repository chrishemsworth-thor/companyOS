import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban } from "lucide-react";
import { useAuth } from "../../../auth/AuthContext";
import { Badge } from "../../../components/Badge";
import { DEPARTMENTS } from "../../../lib/departments";
import { formatMoney } from "../../../lib/format";
import { ReceiptThumbnail } from "./ReceiptThumbnail";
import type { ApprovalRendererProps } from "./types";
import type { ClaimDetail, ExpenseClaimLine } from "../../../api/types";

/**
 * The expense-claim context card (PRD-006a, for PRD-007's renderer registry).
 *
 * PRD-006's second submission criterion is that a receipt photo "displays in the
 * approval view", and the S5 brief asks for it "inline and zoomable" alongside
 * category, amount, project, limit status and the line breakdown. So this card
 * shows an approver everything they need to decide without opening another screen
 * — which matters most on a phone, the one surface PRD-007 gives a hard
 * commitment to.
 *
 * The shell knows none of this: it renders whatever the registry hands it. This
 * file plus one line in `registry.ts` is the whole cost of the type, which is
 * PRD-007's own success metric.
 */

function departmentLabel(code: string | null): string | null {
  if (!code) return null;
  return DEPARTMENTS.find((d) => d.id === code)?.label ?? code;
}

/** The dimensions actually in force on a line: its own, else the claim's. */
function effectiveDimensions(line: ExpenseClaimLine, claim: ClaimDetail["claim"]) {
  return {
    project_id: line.project_id ?? claim.project_id,
    department_code: line.department_code ?? claim.department_code,
  };
}

export function ExpenseClaimCard({ approval }: ApprovalRendererProps) {
  const { client } = useAuth();

  const query = useQuery({
    queryKey: ["claims", approval.subject_id],
    queryFn: () => client!.get<ClaimDetail>(`/v1/claims/${approval.subject_id}`),
    enabled: !!client,
  });

  if (query.isLoading) {
    return (
      <div role="status" aria-label="Loading claim" className="flex flex-col gap-2">
        <div className="h-4 w-40 animate-pulse rounded bg-surface-2" />
        <div className="h-24 w-full animate-pulse rounded bg-surface-2" />
      </div>
    );
  }

  // A claim the caller cannot read, or one that has since been deleted. The card
  // must degrade rather than take the inbox down with it — PRD-007 requires an
  // approval whose subject is unavailable to still render.
  if (query.isError || !query.data) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
        <Ban className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
        <span>
          This claim could not be loaded. It may have been withdrawn, or you may not have access to
          it. Reference <span className="font-mono">{approval.subject_id}</span>.
        </span>
      </div>
    );
  }

  const { claim, lines, limit_warnings } = query.data;
  const money = (cents: number) => formatMoney(cents, claim.currency);
  const claimDepartment = departmentLabel(claim.department_code);

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-subtle">Total</dt>
        <dd className="text-base font-semibold text-fg">{money(claim.total_cents)}</dd>

        <dt className="text-subtle">Claim date</dt>
        <dd className="text-fg">{claim.claim_date}</dd>

        {claim.project_id && (
          <>
            <dt className="text-subtle">Project</dt>
            <dd className="font-mono text-xs text-fg">{claim.project_id}</dd>
          </>
        )}

        {claimDepartment && (
          <>
            <dt className="text-subtle">Department</dt>
            <dd className="text-fg">{claimDepartment}</dd>
          </>
        )}

        {claim.description && (
          <>
            <dt className="text-subtle">Note</dt>
            <dd className="text-fg">{claim.description}</dd>
          </>
        )}

        {claim.tax_cents > 0 && (
          <>
            <dt className="text-subtle">Of which tax</dt>
            {/* The line amounts are gross; tax is shown for information because it
                is not posted separately until the tax work lands. */}
            <dd className="text-fg">{money(claim.tax_cents)}</dd>
          </>
        )}
      </dl>

      {/* Limit status, per the brief. A warning, never a blocker: PRD-006 lets an
          over-limit claim submit, so the approver is the one who decides what to
          do about it and needs the numbers to do that. */}
      {limit_warnings.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md border border-warn bg-warn-bg px-3 py-2 text-xs text-warn">
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

      {/* Line breakdown. Stacks at every width — an approver on a phone is the
          expected reader, not the exception. */}
      <ul className="flex flex-col gap-2">
        {lines.map((line) => {
          const dimensions = effectiveDimensions(line, claim);
          const lineDepartment = departmentLabel(dimensions.department_code);
          return (
            <li
              key={line.line_no}
              className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-2 sm:flex-row sm:items-start"
            >
              <div className="w-full sm:w-40 sm:shrink-0">
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
                  {/* The GL account the line will debit on approval. An approver
                      who can see where the money lands is an approver who can
                      catch a mis-categorised claim before it reaches the books. */}
                  <Badge tone="neutral" dot={false}>
                    {line.account_code} {line.account_name}
                  </Badge>
                  {dimensions.project_id && (
                    <Badge tone="neutral" dot={false}>
                      {dimensions.project_id}
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

      {/* Only shown once it exists, i.e. on the History tab. It is the proof the
          claim reached the ledger, which is the whole point of PRD-006a. */}
      {claim.entry_id && (
        <p className="text-xs text-subtle">
          Posted as journal entry <span className="font-mono">{claim.entry_id}</span>
        </p>
      )}
    </div>
  );
}
