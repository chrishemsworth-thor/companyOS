import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { formatDate } from "../../lib/format";
import type { Project } from "../../api/types";

export function ProjectList() {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["projects"],
    queryFn: () => client!.get<{ projects: Project[] }>("/v1/projects"),
    enabled: !!client,
  });

  return (
    <div>
      <h1>Projects</h1>
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.projects}
          rowKey={(r) => r.project_id}
          rowHref={(r) => `/projects/${r.project_id}`}
          columns={[
            { header: "Project", render: (r) => r.name },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Created", render: (r) => formatDate(r.created_at) },
          ]}
        />
      )}
    </div>
  );
}
