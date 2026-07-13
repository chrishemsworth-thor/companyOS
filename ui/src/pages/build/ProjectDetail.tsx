import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { DataTable } from "../../components/DataTable";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { IssueCreateModal } from "../../components/modals/IssueCreateModal";
import { formatDate } from "../../lib/format";
import type { Project, Issue } from "../../api/types";

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

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
      <BackLink to="/projects">Projects</BackLink>
      <PageHeader title={project.name}>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New issue
        </Button>
        <StatusBadge status={project.status} />
      </PageHeader>
      {creating && (
        <IssueCreateModal
          defaultProjectId={project.project_id}
          onClose={() => setCreating(false)}
          onCreated={(issue) => navigate(`/issues/${issue.issue_id}`)}
        />
      )}
      <DetailGrid>
        <Field label="Project id">
          <span className="font-mono">{project.project_id}</span>
        </Field>
        <Field label="Created">{formatDate(project.created_at)}</Field>
      </DetailGrid>

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
