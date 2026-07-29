import type { ReactNode } from "react";
import { AlertCircle, Lock } from "lucide-react";
import { ApiError } from "../api/client";

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

/**
 * A 403 is not a fault — it is the role working as configured (PRD-008), so it
 * reads as an explanation rather than a red alarm. Every page inherits this via
 * `ErrorState`, which means a surface reachable by a role that cannot read it
 * degrades to a clear message instead of "Something went wrong".
 */
export function ForbiddenState({ message }: { message?: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-border-strong bg-surface p-4 text-muted"
    >
      <Lock className="mt-0.5 size-5 shrink-0 text-subtle" aria-hidden />
      <div className="text-sm">
        <div className="font-semibold text-fg">Not available on your role</div>
        <div className="opacity-90">
          {message ?? "Ask an administrator if you need access to this."}
        </div>
      </div>
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 403) {
    // CSRF failures also 403; those carry no `forbidden` code and are a genuine
    // fault, so they keep the error treatment.
    if (error.code === "forbidden") return <ForbiddenState />;
  }
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
