import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { TeamFormModal } from "../../components/modals/TeamFormModal";
import { departmentLabel } from "./EmployeeList";
import type { Employee, Team } from "../../api/types";

export function TeamList() {
  const { client } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Team | null>(null);

  const query = useQuery({
    queryKey: ["teams"],
    queryFn: () => client!.get<{ teams: Team[] }>("/v1/people/teams"),
    enabled: !!client,
  });
  const employeesQuery = useQuery({
    queryKey: ["employees"],
    queryFn: () => client!.get<{ employees: Employee[] }>("/v1/people/employees?limit=200"),
    enabled: !!client,
  });

  const employees = employeesQuery.data?.employees ?? [];
  const employeeName = (id: string | null) =>
    employees.find((e) => e.employee_id === id)?.name ?? "—";
  const memberCount = (teamId: string) => employees.filter((e) => e.team_id === teamId).length;

  return (
    <div>
      <PageHeader title="Teams">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New team
        </Button>
      </PageHeader>
      {creating && <TeamFormModal onClose={() => setCreating(false)} />}
      {editing && <TeamFormModal existing={editing} onClose={() => setEditing(null)} />}
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.teams}
          rowKey={(r) => r.team_id}
          columns={[
            { header: "Team", render: (r) => r.name },
            { header: "Department", render: (r) => departmentLabel(r.department_id) },
            { header: "Lead", render: (r) => employeeName(r.lead_employee_id) },
            { header: "Members", render: (r) => memberCount(r.team_id) },
            {
              header: "",
              align: "right",
              render: (r) => (
                <Button
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(r);
                  }}
                >
                  Edit
                </Button>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
