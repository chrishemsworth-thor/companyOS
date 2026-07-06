import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowHref,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
}) {
  const navigate = useNavigate();

  if (rows.length === 0) {
    return <div className="empty-state">No records.</div>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.header} style={{ textAlign: col.align ?? "left" }}>
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={rowKey(row)}
            className={rowHref ? "clickable" : undefined}
            onClick={rowHref ? () => navigate(rowHref(row)) : undefined}
          >
            {columns.map((col) => (
              <td key={col.header} style={{ textAlign: col.align ?? "left" }}>
                {col.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
