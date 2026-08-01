import { Badge, type Tone } from "./Badge";

const TONE_BY_STATUS: Record<string, Tone> = {
  draft: "neutral",
  sent: "neutral",
  overdue: "bad",
  partially_paid: "warn",
  paid: "good",
  cancelled: "neutral",
  open: "neutral",
  pending: "warn",
  resolved: "good",
  closed: "neutral",
  won: "good",
  lost: "bad",
  new: "neutral",
  qualified: "warn",
  converted: "good",
  active: "good",
  invited: "warn",
  // Expense-claim states (PRD-006a). `draft`, `paid` and `cancelled` are already
  // above; `rejected` is `bad` rather than neutral because it is the one state
  // that needs the employee to do something.
  submitted: "warn",
  approved: "good",
  rejected: "bad",
  archived: "neutral",
  todo: "neutral",
  in_progress: "warn",
  done: "good",
  low: "neutral",
  normal: "neutral",
  medium: "warn",
  high: "warn",
  urgent: "bad",
  // Leave request states (PRD-006c). `approved`, `rejected` and `cancelled` are
  // already covered above or fall through to neutral; `cancellation_pending` is
  // the one that needs a tone, and it is a warn because it is awaiting somebody.
  approved: "good",
  rejected: "bad",
  cancellation_pending: "warn",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = TONE_BY_STATUS[status] ?? "neutral";
  return <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge>;
}
