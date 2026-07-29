import { FileQuestion } from "lucide-react";
import { subjectLabel, subjectRoute } from "../../../lib/subjectRoutes";
import { formatDate } from "../../../lib/format";
import type { ApprovalRendererProps } from "./types";

/**
 * The fallback renderer (PRD-007: "given a new `subject_type` with no registered
 * renderer, then a generic fallback card renders rather than crashing").
 *
 * This is the only renderer S4 ships. Leave and expense-claim cards arrive with
 * S7 and S5, the quote card with S9, and no invoice card is built at all —
 * `invoice` is a reserved subject type nothing in the codebase creates
 * (SESSION-PLAN conflict C5), and the fallback covers it if one ever appears.
 *
 * It shows only what the approvals row itself carries, because that is all it can
 * know: who asked, what kind of thing, which id, and when. That is thin on
 * purpose — a decision made from this card is a decision made on trust, so the
 * card says as much rather than implying it has the full picture.
 */
export function GenericApprovalCard({ approval, userName }: ApprovalRendererProps) {
  const route = subjectRoute(approval.subject_type, approval.subject_id);

  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-subtle">Type</dt>
        <dd className="font-medium text-fg">{subjectLabel(approval.subject_type)}</dd>

        <dt className="text-subtle">Requested by</dt>
        <dd className="text-fg">
          {approval.requested_by ? (
            userName(approval.requested_by)
          ) : (
            // A programmatic caller raised this — a tenant API key has no user
            // identity. Rare, but naming it beats an empty cell.
            <span className="italic text-subtle">An integration</span>
          )}
        </dd>

        <dt className="text-subtle">Reference</dt>
        <dd className="font-mono text-xs text-muted">{approval.subject_id}</dd>

        <dt className="text-subtle">Raised</dt>
        <dd className="text-fg">{formatDate(approval.created_at)}</dd>
      </dl>

      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
        <FileQuestion className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
        <span>
          {/* Two different situations, one card, and the wording has to be honest
              about which. A routable subject means the module exists and the
              renderer simply has not been written; no route means the module
              itself has not shipped in this build. */}
          {route ? (
            <>
              No detailed view for this type yet —{" "}
              <a href={route} className="font-semibold">
                open the {subjectLabel(approval.subject_type).toLowerCase()}
              </a>{" "}
              to see the full context before deciding.
            </>
          ) : (
            <>
              This build has no detailed view for{" "}
              <span className="font-semibold">{subjectLabel(approval.subject_type)}</span>. Only the
              request itself is shown above.
            </>
          )}
        </span>
      </div>
    </div>
  );
}
