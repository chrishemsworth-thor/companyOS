import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus, ChevronDown } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { StatusBadge } from "../../components/StatusBadge";
import { StatusFilter } from "../../components/FilterBar";
import { EmployeeFormModal } from "../../components/modals/EmployeeFormModal";
import { DEPARTMENTS } from "../../lib/departments";
import type { Employee, Team } from "../../api/types";

export function departmentLabel(id: string | null): string {
  return DEPARTMENTS.find((d) => d.id === id)?.label ?? id ?? "—";
}

export function EmployeeList() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [department, setDepartment] = useState("");
  const [status, setStatus] = useState("");

  const params = new URLSearchParams({ limit: "200" });
  if (department) params.set("department_id", department);
  if (status) params.set("status", status);

  const query = useQuery({
    queryKey: ["employees", { department, status }],
    queryFn: () => client!.get<{ employees: Employee[] }>(`/v1/people/employees?${params}`),
    enabled: !!client,
  });
  const teamsQuery = useQuery({
    queryKey: ["teams"],
    queryFn: () => client!.get<{ teams: Team[] }>("/v1/people/teams"),
    enabled: !!client,
  });
  const teamName = (id: string | null) =>
    teamsQuery.data?.teams.find((t) => t.team_id === id)?.name ?? "—";

  return (
    <div>
      <PageHeader title="Employees">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New employee
        </Button>
      </PageHeader>
      {creating && (
        <EmployeeFormModal
          onClose={() => setCreating(false)}
          onSaved={(employee) => navigate(`/employees/${employee.employee_id}`)}
        />
      )}
      <div className="mb-4 flex gap-2">
        <div className="relative inline-flex">
          <select
            className="h-10 cursor-pointer appearance-none rounded-md border border-border bg-surface pl-3 pr-9 text-sm text-fg transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
          >
            <option value="">All departments</option>
            {DEPARTMENTS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle"
            aria-hidden
          />
        </div>
        <StatusFilter value={status} options={["active", "inactive"]} onChange={setStatus} />
      </div>
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.employees}
          rowKey={(r) => r.employee_id}
          rowHref={(r) => `/employees/${r.employee_id}`}
          columns={[
            { header: "Name", render: (r) => r.name },
            { header: "Job title", render: (r) => r.job_title ?? "—" },
            { header: "Department", render: (r) => departmentLabel(r.department_id) },
            { header: "Team", render: (r) => teamName(r.team_id) },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      )}
    </div>
  );
}
