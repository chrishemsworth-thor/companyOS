import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { useAuth } from "../../auth/AuthContext";
import { useApiMutation } from "../../hooks/useApiMutation";
import type { Issue, IssuePriority, Project } from "../../api/types";

const PRIORITIES: IssuePriority[] = ["low", "medium", "high", "urgent"];

export function IssueCreateModal({
  defaultProjectId,
  onClose,
  onCreated,
}: {
  defaultProjectId?: string;
  onClose: () => void;
  onCreated?: (issue: Issue) => void;
}) {
  const { client } = useAuth();
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [assignee, setAssignee] = useState("");

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => client!.get<{ projects: Project[] }>("/v1/projects"),
    enabled: !!client && !defaultProjectId,
  });

  const mutation = useApiMutation({
    mutationFn: (
      client,
      vars: {
        project_id: string;
        title: string;
        description?: string;
        priority: IssuePriority;
        assignee?: string;
      },
    ) => client.post<Issue>("/v1/issues", vars),
    invalidates: (vars) => [["issues"], ["issues", { project_id: vars.project_id }]],
    onSuccess: (issue) => {
      onClose();
      onCreated?.(issue);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
      project_id: projectId,
      title: title.trim(),
      priority,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(assignee.trim() ? { assignee: assignee.trim() } : {}),
    });
  };

  return (
    <Modal title="New issue" onClose={onClose}>
      <form onSubmit={submit}>
        {!defaultProjectId && (
          <FormRow label="Project">
            <select
              className="input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              required
            >
              <option value="" disabled>
                {projectsQuery.isLoading ? "Loading projects…" : "Select project"}
              </option>
              {projectsQuery.data?.projects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </FormRow>
        )}
        <FormRow label="Title">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            required
          />
        </FormRow>
        <FormRow label="Description (optional)">
          <textarea
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={10_000}
          />
        </FormRow>
        <div className="form-row-inline">
          <FormRow label="Priority">
            <select
              className="input"
              value={priority}
              onChange={(e) => setPriority(e.target.value as IssuePriority)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label="Assignee (optional)">
            <input
              className="input"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              maxLength={200}
            />
          </FormRow>
        </div>
        <FormError error={mutation.error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={mutation.isPending || !projectId}
          >
            {mutation.isPending ? "Creating…" : "Create issue"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
