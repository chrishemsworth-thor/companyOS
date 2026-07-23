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
  archived: "neutral",
  todo: "neutral",
  in_progress: "warn",
  done: "good",
  low: "neutral",
  normal: "neutral",
  medium: "warn",
  high: "warn",
  urgent: "bad",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = TONE_BY_STATUS[status] ?? "neutral";
  return <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge>;
}
