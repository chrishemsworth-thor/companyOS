import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { useApiMutation } from "../../hooks/useApiMutation";
import type { Project } from "../../api/types";

export function ProjectCreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (project: Project) => void;
}) {
  const [name, setName] = useState("");

  const mutation = useApiMutation({
    mutationFn: (client, vars: { name: string }) => client.post<Project>("/v1/projects", vars),
    invalidates: () => [["projects"]],
    onSuccess: (project) => {
      onClose();
      onCreated?.(project);
    },
  });

  return (
    <Modal title="New project" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ name: name.trim() });
        }}
      >
        <FormRow label="Name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
          />
        </FormRow>
        <FormError error={mutation.error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
