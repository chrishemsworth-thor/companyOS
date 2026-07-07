import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { StatusBadge } from "../../components/StatusBadge";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { formatDate } from "../../lib/format";
import type { Issue, IssueStatus } from "../../api/types";

/** Mirrors the backend rule: settled issues can only be re-opened to todo. */
function legalStatuses(from: IssueStatus): IssueStatus[] {
  if (from === "done" || from === "cancelled") return [from, "todo"];
  return ["todo", "in_progress", "done", "cancelled"];
}

export function IssueDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["issue", id],
    queryFn: () => client!.get<Issue>(`/v1/issues/${id}`),
    enabled: !!client && !!id,
  });

  // Optimistic like deal stage moves: flip immediately, roll back on error.
  const statusMutation = useMutation({
    mutationFn: (status: IssueStatus) =>
      client!.post<Issue>(`/v1/issues/${id}/status`, { status }),
    onMutate: async (status) => {
      await queryClient.cancelQueries({ queryKey: ["issue", id] });
      const previous = queryClient.getQueryData<Issue>(["issue", id]);
      if (previous) queryClient.setQueryData<Issue>(["issue", id], { ...previous, status });
      return { previous };
    },
    onError: (_err, _status, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["issue", id], ctx.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["issue", id] });
      void queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
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
        <div className="action-bar">
          <select
            className="input"
            style={{ width: "auto" }}
            value={issue.status}
            onChange={(e) => statusMutation.mutate(e.target.value as IssueStatus)}
            disabled={statusMutation.isPending}
          >
            {legalStatuses(issue.status).map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
          <StatusBadge status={issue.status} />
        </div>
      </div>
      <FormError error={statusMutation.error} />
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
