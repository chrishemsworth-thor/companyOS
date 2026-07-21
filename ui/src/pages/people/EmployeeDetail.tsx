import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { StatusBadge } from "../../components/StatusBadge";
import { EmployeeFormModal } from "../../components/modals/EmployeeFormModal";
import { formatDate } from "../../lib/format";
import { departmentLabel } from "./EmployeeList";
import type { Employee, Team } from "../../api/types";

export function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const [editing, setEditing] = useState(false);

  const employeeQuery = useQuery({
    queryKey: ["employees", id],
    queryFn: () => client!.get<Employee>(`/v1/people/employees/${id}`),
    enabled: !!client && !!id,
  });
  const managerId = employeeQuery.data?.manager_employee_id;
  const managerQuery = useQuery({
    queryKey: ["employees", managerId],
    queryFn: () => client!.get<Employee>(`/v1/people/employees/${managerId}`),
    enabled: !!client && !!managerId,
  });
  const reportsQuery = useQuery({
    queryKey: ["employees", { manager: id }],
    queryFn: () =>
      client!.get<{ employees: Employee[] }>(`/v1/people/employees?manager_id=${id}&limit=200`),
    enabled: !!client && !!id,
  });
  const teamsQuery = useQuery({
    queryKey: ["teams"],
    queryFn: () => client!.get<{ teams: Team[] }>("/v1/people/teams"),
    enabled: !!client,
  });

  if (employeeQuery.isLoading) return <LoadingState />;
  if (employeeQuery.error) return <ErrorState error={employeeQuery.error} />;
  const employee = employeeQuery.data;
  if (!employee) return null;

  const team = teamsQuery.data?.teams.find((t) => t.team_id === employee.team_id);
  const reports = reportsQuery.data?.employees ?? [];

  return (
    <div>
      <BackLink to="/employees">Employees</BackLink>
      <PageHeader title={employee.name}>
        <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
          Edit
        </Button>
      </PageHeader>
      {editing && <EmployeeFormModal existing={employee} onClose={() => setEditing(false)} />}
      <DetailGrid>
        <Field label="Status">
          <StatusBadge status={employee.status} />
        </Field>
        <Field label="Job title">{employee.job_title ?? "—"}</Field>
        <Field label="Department">{departmentLabel(employee.department_id)}</Field>
        <Field label="Team">{team?.name ?? "—"}</Field>
        <Field label="Manager">
          {managerId ? (
            <Link className="text-accent hover:underline" to={`/employees/${managerId}`}>
              {managerQuery.data?.name ?? managerId}
            </Link>
          ) : (
            "—"
          )}
        </Field>
        <Field label="Email">{employee.email ?? "—"}</Field>
        <Field label="Phone">{employee.phone ?? "—"}</Field>
        <Field label="Employment">{employee.employment_type.replace(/_/g, " ")}</Field>
        <Field label="Start date">{employee.start_date ? formatDate(employee.start_date) : "—"}</Field>
        <Field label="Location">{employee.location ?? "—"}</Field>
      </DetailGrid>

      <h2 className="mb-3 mt-8 text-sm font-semibold text-fg">Direct reports</h2>
      {reports.length === 0 ? (
        <p className="text-sm text-subtle">No direct reports.</p>
      ) : (
        <DataTable
          rows={reports}
          rowKey={(r) => r.employee_id}
          rowHref={(r) => `/employees/${r.employee_id}`}
          columns={[
            { header: "Name", render: (r) => r.name },
            { header: "Job title", render: (r) => r.job_title ?? "—" },
            { header: "Department", render: (r) => departmentLabel(r.department_id) },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      )}
    </div>
  );
}
