import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { DataTable } from "../../components/DataTable";
import { Field } from "../../components/Field";
import { formatDate } from "../../lib/format";
import type { Project, Issue } from "../../api/types";

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();

  const projectQuery = useQuery({
    queryKey: ["project", id],
    queryFn: () => client!.get<Project>(`/v1/projects/${id}`),
    enabled: !!client && !!id,
  });
  const issuesQuery = useQuery({
    queryKey: ["issues", { project_id: id }],
    queryFn: () => client!.get<{ issues: Issue[] }>(`/v1/issues?project_id=${id}`),
    enabled: !!client && !!id,
  });

  if (projectQuery.isLoading) return <LoadingState />;
  if (projectQuery.error) return <ErrorState error={projectQuery.error} />;
  const project = projectQuery.data;
  if (!project) return null;

  return (
    <div>
      <Link to="/projects" className="back-link">
        ← Projects
      </Link>
      <div className="page-header">
        <h1>{project.name}</h1>
        <StatusBadge status={project.status} />
      </div>
      <div className="detail-grid">
        <Field label="Created">{formatDate(project.created_at)}</Field>
      </div>

      <h2>Issues</h2>
      {issuesQuery.isLoading && <LoadingState />}
      {issuesQuery.data && (
        <DataTable
          rows={issuesQuery.data.issues}
          rowKey={(r) => r.issue_id}
          rowHref={(r) => `/issues/${r.issue_id}`}
          columns={[
            { header: "Title", render: (r) => r.title },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Priority", render: (r) => <StatusBadge status={r.priority} /> },
            { header: "Assignee", render: (r) => r.assignee ?? "—" },
          ]}
        />
      )}
    </div>
  );
}
