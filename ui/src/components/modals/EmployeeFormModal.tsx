import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { EmployeeSelect } from "../EmployeeSelect";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useAuth } from "../../auth/AuthContext";
import { DEPARTMENTS } from "../../lib/departments";
import type { Employee, EmploymentType, EmployeeStatus, Team } from "../../api/types";

const EMPLOYMENT_TYPES: EmploymentType[] = ["full_time", "part_time", "contract", "intern"];

/** Create an employee, or edit the profile/org placement when `existing` is passed. */
export function EmployeeFormModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Employee;
  onClose: () => void;
  onSaved?: (employee: Employee) => void;
}) {
  const { client } = useAuth();
  const [name, setName] = useState(existing?.name ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [jobTitle, setJobTitle] = useState(existing?.job_title ?? "");
  const [departmentId, setDepartmentId] = useState(existing?.department_id ?? "");
  const [teamId, setTeamId] = useState(existing?.team_id ?? "");
  const [managerId, setManagerId] = useState(existing?.manager_employee_id ?? "");
  const [employmentType, setEmploymentType] = useState<EmploymentType>(
    existing?.employment_type ?? "full_time",
  );
  const [status, setStatus] = useState<EmployeeStatus>(existing?.status ?? "active");
  const [startDate, setStartDate] = useState(existing?.start_date ?? "");
  const [location, setLocation] = useState(existing?.location ?? "");

  const teamsQuery = useQuery({
    queryKey: ["teams"],
    queryFn: () => client!.get<{ teams: Team[] }>("/v1/people/teams"),
    enabled: !!client,
  });

  const mutation = useApiMutation({
    mutationFn: (client, body: Record<string, unknown>) =>
      existing
        ? client.patch<Employee>(`/v1/people/employees/${existing.employee_id}`, body)
        : client.post<Employee>("/v1/people/employees", body),
    invalidates: () => [["employees"], ["teams"]],
    onSuccess: (employee) => {
      onSaved?.(employee);
      onClose();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // On edit, empty selects clear the field (null); on create they're omitted.
    const opt = (v: string) => (existing ? v || null : v || undefined);
    mutation.mutate({
      name: name.trim(),
      email: opt(email.trim()),
      job_title: opt(jobTitle.trim()),
      department_id: departmentId,
      team_id: opt(teamId),
      manager_employee_id: opt(managerId),
      employment_type: employmentType,
      ...(existing ? { status } : {}),
      start_date: opt(startDate),
      location: opt(location.trim()),
    });
  };

  return (
    <Modal title={existing ? `Edit ${existing.name}` : "New employee"} onClose={onClose}>
      <form onSubmit={submit}>
        <FormRow label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </FormRow>
        <FormRow label="Work email (optional)">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormRow>
        <FormRow label="Job title (optional)">
          <input className="input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
        </FormRow>
        <FormRow label="Department">
          <select
            className="input"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            required
          >
            <option value="" disabled>
              Select department
            </option>
            {DEPARTMENTS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="Team (optional)">
          <select
            className="input"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            disabled={teamsQuery.isLoading}
          >
            <option value="">None</option>
            {teamsQuery.data?.teams.map((t) => (
              <option key={t.team_id} value={t.team_id}>
                {t.name}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="Manager (optional)">
          <EmployeeSelect value={managerId} onChange={setManagerId} exclude={existing?.employee_id} />
        </FormRow>
        <FormRow label="Employment type">
          <select
            className="input"
            value={employmentType}
            onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
          >
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </FormRow>
        {existing && (
          <FormRow label="Status">
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as EmployeeStatus)}
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </FormRow>
        )}
        <FormRow label="Start date (optional)">
          <input
            className="input"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </FormRow>
        <FormRow label="Location (optional)">
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
        </FormRow>
        <FormError error={mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : existing ? "Save changes" : "Create employee"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
