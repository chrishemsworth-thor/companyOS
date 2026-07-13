import type { ReactNode } from "react";

/** Page title with an optional actions cluster; wraps gracefully on narrow screens. */
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="m-0">{title}</h1>
      {children != null && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
