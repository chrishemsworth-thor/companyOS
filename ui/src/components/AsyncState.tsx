import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";

const SKELETON_WIDTHS = ["70%", "92%", "60%", "82%"];

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="rounded-lg border border-border bg-surface p-4 shadow-sm"
      role="status"
      aria-label={label}
    >
      <div className="flex flex-col gap-3">
        {SKELETON_WIDTHS.map((w, i) => (
          <div
            key={i}
            className="h-4 animate-pulse rounded bg-surface-2"
            style={{ width: w }}
          />
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-bad/40 bg-bad-bg/60 p-4 text-bad"
    >
      <AlertCircle className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="text-sm">
        <div className="font-semibold">Something went wrong</div>
        <div className="opacity-90">{message}</div>
      </div>
    </div>
  );
}

export function EmptyState({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-10 text-center text-muted">
      {icon && <span className="text-subtle">{icon}</span>}
      <div className="text-sm">{children}</div>
    </div>
  );
}
