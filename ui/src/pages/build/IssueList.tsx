import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { StatusFilter } from "../../components/FilterBar";
import type { Issue, IssueStatus } from "../../api/types";

const STATUSES: IssueStatus[] = ["todo", "in_progress", "done", "cancelled"];

export function IssueList() {
  const { client } = useAuth();
  const [status, setStatus] = useState("");
  const query = useQuery({
    queryKey: ["issues", { status }],
    queryFn: () =>
      client!.get<{ issues: Issue[] }>(`/v1/issues${status ? `?status=${status}` : ""}`),
    enabled: !!client,
  });

  return (
    <div>
      <div className="page-header">
        <h1>Issues</h1>
        <StatusFilter value={status} options={STATUSES} onChange={setStatus} />
      </div>
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.issues}
          rowKey={(r) => r.issue_id}
          rowHref={(r) => `/issues/${r.issue_id}`}
          columns={[
            { header: "Title", render: (r) => r.title },
            { header: "Project", render: (r) => r.project_id },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Priority", render: (r) => <StatusBadge status={r.priority} /> },
            { header: "Assignee", render: (r) => r.assignee ?? "—" },
          ]}
        />
      )}
    </div>
  );
}
