import { useState } from "react";
import { Check, Clock, X } from "lucide-react";
import { Button } from "../../components/Button";
import { Badge, type Tone } from "../../components/Badge";
import { subjectLabel } from "../../lib/subjectRoutes";
import { getApprovalRenderer } from "./renderers/registry";
import type { Approval, ApprovalState } from "../../api/types";

/**
 * One approval, as a card (PRD-007 § "P0 — Approvals inbox").
 *
 * The generic shell: heading, age, the type-specific renderer slot, and the
 * decision actions. It knows nothing about any particular subject — that is the
 * registry's job — which is what keeps a new approvable type down to one file.
 *
 * Mobile is a hard requirement here, not a nice-to-have: PRD-007 gives
 * `/approvals` the console's only 375px commitment because approvers are on
 * phones. So the card stacks at every width, and Approve/Reject are full-width
 * 40px-tall targets on small screens.
 */

const STATE_TONES: Record<ApprovalState, Tone> = {
  pending: "warn",
  approved: "good",
  rejected: "bad",
  cancelled: "neutral",
};

/**
 * Age in the coarsest unit that is still honest.
 *
 * "Age prominently displayed" is PRD-007's wording, and prominence is the point:
 * a request waiting eleven days is the one blocking somebody. Rounded down, so
 * nothing is ever overstated.
 */
export function formatAge(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Old enough that the age deserves to look like a problem. */
const STALE_DAYS = 3;

function isStale(iso: string, now: number = Date.now()): boolean {
  const then = new Date(iso).getTime();
  return !Number.isNaN(then) && now - then > STALE_DAYS * 24 * 60 * 60 * 1000;
}

export interface ApprovalCardProps {
  approval: Approval;
  userName: (userId: string | null) => string;
  /** Absent on the History and My requests tabs, where there is nothing to decide. */
  onDecide?: (decision: "approve" | "reject", comment: string) => void;
  deciding?: boolean;
  /** Extra controls for the My requests tab (nudge, cancel). */
  actions?: React.ReactNode;
}

export function ApprovalCard({
  approval,
  userName,
  onDecide,
  deciding = false,
  actions,
}: ApprovalCardProps) {
  const [comment, setComment] = useState("");
  // Set when Reject is pressed with an empty comment. PRD-007 requires the
  // action be "blocked with an inline message" — so this is a local validation
  // state, not a request that comes back 400.
  const [commentRequired, setCommentRequired] = useState(false);

  const Renderer = getApprovalRenderer(approval.subject_type);
  const stale = isStale(approval.created_at);

  function decide(decision: "approve" | "reject") {
    // Reject requires a comment; approve does not. The asymmetry is deliberate
    // and matches the PRD: an approval needs no justification, but a rejection
    // that says nothing sends the requester back to work with no idea what to
    // change. The API deliberately does NOT enforce this (S3 kept the primitive
    // permissive for programmatic callers), so the console is the only place it
    // lives.
    if (decision === "reject" && comment.trim() === "") {
      setCommentRequired(true);
      return;
    }
    setCommentRequired(false);
    onDecide?.(decision, comment.trim());
  }

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-tight text-fg">
            {subjectLabel(approval.subject_type)}
          </h3>
          <div className="mt-0.5 text-sm text-subtle">
            {approval.requested_by ? `from ${userName(approval.requested_by)}` : "from an integration"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            title={approval.created_at}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm font-semibold ${
              stale && approval.state === "pending"
                ? "bg-bad-bg text-bad"
                : "bg-surface-2 text-muted"
            }`}
          >
            <Clock className="size-3.5" aria-hidden />
            {formatAge(approval.created_at)}
          </span>
          {approval.state !== "pending" && (
            <Badge tone={STATE_TONES[approval.state]}>{approval.state}</Badge>
          )}
        </div>
      </header>

      {/* The type-specific slot. Generic fallback when nothing is registered. */}
      <Renderer approval={approval} userName={userName} />

      {approval.decision_comment && (
        <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-subtle">Comment</div>
          <div className="text-fg">{approval.decision_comment}</div>
        </div>
      )}

      {onDecide && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`comment-${approval.approval_id}`}>
            Comment
          </label>
          <textarea
            id={`comment-${approval.approval_id}`}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              if (commentRequired && e.target.value.trim() !== "") setCommentRequired(false);
            }}
            rows={2}
            placeholder="Add a comment (required to reject)"
            aria-invalid={commentRequired || undefined}
            aria-describedby={commentRequired ? `comment-error-${approval.approval_id}` : undefined}
            className={`w-full resize-y rounded-md border bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-ring ${
              commentRequired ? "border-bad" : "border-border"
            }`}
          />
          {commentRequired && (
            <p
              id={`comment-error-${approval.approval_id}`}
              role="alert"
              className="text-sm font-medium text-bad"
            >
              A comment is required to reject — the requester needs to know what to change.
            </p>
          )}
          {/* Stacked and full-width on mobile; side by side from `sm` up. */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="primary"
              onClick={() => decide("approve")}
              disabled={deciding}
              icon={<Check className="size-4" />}
              className="w-full sm:w-auto"
            >
              Approve
            </Button>
            <Button
              variant="danger"
              onClick={() => decide("reject")}
              disabled={deciding}
              icon={<X className="size-4" />}
              className="w-full sm:w-auto"
            >
              Reject
            </Button>
          </div>
        </div>
      )}

      {actions && <div className="flex flex-col gap-2 sm:flex-row">{actions}</div>}
    </article>
  );
}
