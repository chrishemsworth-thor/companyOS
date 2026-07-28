import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Pencil, UserPlus } from "lucide-react";
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
import { EmployeeInviteModal } from "../../components/modals/EmployeeInviteModal";
import type { AdminUser } from "../../components/modals/UserFormModal";
import { formatDate } from "../../lib/format";
import { departmentLabel } from "./EmployeeList";
import type { Employee, Team } from "../../api/types";

export function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const { client, user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const isAdmin = user?.role === "admin";

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
  // Platform-access state comes from the users list (admin-only, same query
  // key the Users page uses) so a linked login can be shown as invited/active.
  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => client!.get<{ users: AdminUser[] }>("/v1/users"),
    enabled: !!client && isAdmin,
  });

  if (employeeQuery.isLoading) return <LoadingState />;
  if (employeeQuery.error) return <ErrorState error={employeeQuery.error} />;
  const employee = employeeQuery.data;
  if (!employee) return null;

  const team = teamsQuery.data?.teams.find((t) => t.team_id === employee.team_id);
  const reports = reportsQuery.data?.employees ?? [];

  const login = employee.user_id
    ? usersQuery.data?.users.find((u) => u.user_id === employee.user_id)
    : undefined;
  // Invitable when there's an email and either no login yet, or one that was
  // never activated (the server treats the latter as a resend).
  const canInvite =
    isAdmin && !!employee.email && employee.status === "active" &&
    (!employee.user_id || login?.status === "invited");

  return (
    <div>
      <BackLink to="/employees">Employees</BackLink>
      <PageHeader title={employee.name}>
        {canInvite && (
          <Button
            icon={<UserPlus className="size-4" />}
            onClick={() => setInviting(true)}
          >
            {employee.user_id ? "Resend invite" : "Invite to platform"}
          </Button>
        )}
        <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
          Edit
        </Button>
      </PageHeader>
      {editing && <EmployeeFormModal existing={employee} onClose={() => setEditing(false)} />}
      {inviting && (
        <EmployeeInviteModal employee={employee} onClose={() => setInviting(false)} />
      )}
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
        {isAdmin && (
          <Field label="Platform access">
            {!employee.user_id ? (
              <span className="text-subtle">No login</span>
            ) : login ? (
              <span className="inline-flex items-center gap-2">
                <StatusBadge status={login.status} />
                <span className="capitalize text-muted">{login.role}</span>
              </span>
            ) : (
              <span className="text-subtle">Linked</span>
            )}
          </Field>
        )}
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
