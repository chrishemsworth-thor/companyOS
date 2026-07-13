import type { ReactNode } from "react";

/** Right-aligned action row for modal footers. */
export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex justify-end gap-2">{children}</div>;
}
