import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { ProjectCreateModal } from "../../components/modals/ProjectCreateModal";
import { formatDate } from "../../lib/format";
import type { Project } from "../../api/types";

export function ProjectList() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["projects"],
    queryFn: () => client!.get<{ projects: Project[] }>("/v1/projects"),
    enabled: !!client,
  });

  return (
    <div>
      <div className="page-header">
        <h1>Projects</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          New project
        </button>
      </div>
      {creating && (
        <ProjectCreateModal
          onClose={() => setCreating(false)}
          onCreated={(project) => navigate(`/projects/${project.project_id}`)}
        />
      )}
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
