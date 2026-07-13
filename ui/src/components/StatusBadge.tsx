import { cn } from "../lib/cn";

type Tone = "neutral" | "good" | "bad" | "warn";

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
  active: "good",
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

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-neutral-bg text-neutral",
  good: "bg-good-bg text-good",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
};

const DOT_CLASSES: Record<Tone, string> = {
  neutral: "bg-neutral",
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = TONE_BY_STATUS[status] ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize",
        TONE_CLASSES[tone],
      )}
    >
      <span className={cn("size-1.5 rounded-full", DOT_CLASSES[tone])} aria-hidden />
      {status.replace(/_/g, " ")}
    </span>
  );
}
