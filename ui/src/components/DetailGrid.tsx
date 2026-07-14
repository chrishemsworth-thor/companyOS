import type { ReactNode } from "react";

/** Card wrapper laying out Field children in a responsive grid. */
export function DetailGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-xl border border-border bg-surface p-5 shadow-sm sm:grid-cols-3 lg:grid-cols-4">
      {children}
    </div>
  );
}
