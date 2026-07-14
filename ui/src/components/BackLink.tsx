import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted no-underline transition-colors hover:text-fg hover:no-underline"
    >
      <ArrowLeft className="size-4" />
      {children}
    </Link>
  );
}
