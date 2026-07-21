import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { EmployeeSelect } from "../EmployeeSelect";
import { useApiMutation } from "../../hooks/useApiMutation";
import { DEPARTMENTS } from "../../lib/departments";
import type { Team } from "../../api/types";

/** Create a team, or edit name/department/lead when `existing` is passed. */
export function TeamFormModal({
  existing,
  onClose,
}: {
  existing?: Team;
  onClose: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [departmentId, setDepartmentId] = useState(existing?.department_id ?? "");
  const [leadId, setLeadId] = useState(existing?.lead_employee_id ?? "");

  const mutation = useApiMutation({
    mutationFn: (client, body: Record<string, unknown>) =>
      existing
        ? client.patch<Team>(`/v1/people/teams/${existing.team_id}`, body)
        : client.post<Team>("/v1/people/teams", body),
    invalidates: () => [["teams"], ["employees"]],
    onSuccess: () => onClose(),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const opt = (v: string) => (existing ? v || null : v || undefined);
    mutation.mutate({
      name: name.trim(),
      description: opt(description.trim()),
      department_id: opt(departmentId),
      lead_employee_id: opt(leadId),
    });
  };

  return (
    <Modal title={existing ? `Edit ${existing.name}` : "New team"} onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </FormRow>
        <FormRow label="Description (optional)">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormRow>
        <FormRow label="Department (optional)">
          <select
            className="input"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
          >
            <option value="">None</option>
            {DEPARTMENTS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="Team lead (optional)">
          <EmployeeSelect value={leadId} onChange={setLeadId} />
        </FormRow>
        <FormError error={mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : existing ? "Save changes" : "Create team"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
