import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
import { formatDate } from "../../lib/format";
import type { Issue } from "../../api/types";

export function IssueDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["issue", id],
    queryFn: () => client!.get<Issue>(`/v1/issues/${id}`),
    enabled: !!client && !!id,
  });

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;
  const issue = query.data;
  if (!issue) return null;

  return (
    <div>
      <Link to="/issues" className="back-link">
        ← Issues
      </Link>
      <div className="page-header">
        <h1>{issue.title}</h1>
        <StatusBadge status={issue.status} />
      </div>
      <div className="detail-grid">
        <Field label="Project">
          <Link to={`/projects/${issue.project_id}`}>{issue.project_id}</Link>
        </Field>
        <Field label="Priority">
          <StatusBadge status={issue.priority} />
        </Field>
        <Field label="Assignee">{issue.assignee ?? "—"}</Field>
        <Field label="Created">{formatDate(issue.created_at)}</Field>
        <Field label="Updated">{formatDate(issue.updated_at)}</Field>
      </div>
      {issue.description && (
        <>
          <h2>Description</h2>
          <p className="description">{issue.description}</p>
        </>
      )}
    </div>
  );
}
