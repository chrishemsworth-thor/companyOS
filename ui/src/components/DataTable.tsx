import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "../lib/cn";
import { EmptyState } from "./AsyncState";

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
}

/**
 * Responsive table. On >=md screens it renders a real table; below that
 * each row collapses into a stacked label:value card so wide business data
 * never forces horizontal scrolling on a phone. Callers pass the same
 * `Column<T>[]` for both.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowHref,
  onRowClick,
  emptyLabel = "No records.",
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyLabel?: string;
}) {
  const navigate = useNavigate();
  const activate = rowHref
    ? (row: T) => navigate(rowHref(row))
    : onRowClick
      ? (row: T) => onRowClick(row)
      : undefined;

  if (rows.length === 0) {
    return <EmptyState>{emptyLabel}</EmptyState>;
  }

  return (
    <>
      {/* Desktop / tablet: table */}
      <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface shadow-sm md:block">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              {columns.map((col) => (
                <th
                  key={col.header}
                  className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted"
                  style={{ textAlign: col.align ?? "left" }}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn(
                  "border-b border-border last:border-0",
                  activate && "cursor-pointer transition-colors hover:bg-surface-2",
                )}
                onClick={activate ? () => activate(row) : undefined}
              >
                {columns.map((col) => (
                  <td
                    key={col.header}
                    className="px-4 py-3 text-sm"
                    style={{ textAlign: col.align ?? "left" }}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards */}
      <div className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => {
          const body = (
            <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-4 shadow-sm">
              {columns.map((col) => (
                <div key={col.header} className="flex items-baseline justify-between gap-3">
                  <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">
                    {col.header}
                  </span>
                  <span className="min-w-0 break-words text-right text-sm">{col.render(row)}</span>
                </div>
              ))}
            </div>
          );
          return activate ? (
            <div
              key={rowKey(row)}
              role={rowHref ? "link" : "button"}
              tabIndex={0}
              onClick={() => activate(row)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate(row);
                }
              }}
              className="cursor-pointer rounded-lg transition-transform active:scale-[0.99]"
            >
              {body}
            </div>
          ) : (
            <div key={rowKey(row)}>{body}</div>
          );
        })}
      </div>
    </>
  );
}
