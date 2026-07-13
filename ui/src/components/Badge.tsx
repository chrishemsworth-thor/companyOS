import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export type Tone = "neutral" | "good" | "warn" | "bad";

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

/** Pill badge with an explicit tone (see StatusBadge for status→tone mapping). */
export function Badge({
  tone = "neutral",
  dot = true,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize",
        TONE_CLASSES[tone],
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", DOT_CLASSES[tone])} aria-hidden />}
      {children}
    </span>
  );
}
