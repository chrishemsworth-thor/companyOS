import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
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
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create project"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
