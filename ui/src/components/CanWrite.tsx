import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import type { CapabilityModule } from "../lib/roles";

/**
 * Renders its children only when the signed-in role may write `module`.
 *
 * Used to hide create/edit actions rather than let someone click them into a
 * 403 — a read-only observer or a finance user browsing Sales sees the data
 * without a row of buttons that cannot work. This is presentation only: the
 * server enforces the same capability on the request itself (PRD-008), so
 * nothing here is a security boundary.
 */
export function CanWrite({
  module,
  children,
}: {
  module: CapabilityModule;
  children: ReactNode;
}) {
  const { can } = useAuth();
  return can(`${module}:write`) ? <>{children}</> : null;
}
