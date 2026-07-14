import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState } from "../components/AsyncState";
import { DataTable } from "../components/DataTable";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/Button";
import { UserFormModal, type AdminUser } from "../components/modals/UserFormModal";
import { formatDate } from "../lib/format";

export function Users() {
  const { client, user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const query = useQuery({
    queryKey: ["users"],
    queryFn: () => client!.get<{ users: AdminUser[] }>("/v1/users"),
    enabled: !!client && user?.role === "admin",
  });

  if (user?.role !== "admin") {
    return (
      <div>
        <h1>Users</h1>
        <p className="muted">User management is restricted to admins.</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Users">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New user
        </Button>
      </PageHeader>
      {creating && <UserFormModal onClose={() => setCreating(false)} />}
      {editing && <UserFormModal existing={editing} onClose={() => setEditing(null)} />}
      {query.isLoading && <LoadingState />}
      {query.error && <ErrorState error={query.error} />}
      {query.data && (
        <DataTable
          rows={query.data.users}
          rowKey={(r) => r.user_id}
          columns={[
            { header: "Email", render: (r) => r.email },
            { header: "Name", render: (r) => r.display_name ?? "—" },
            { header: "Role", render: (r) => <span className="capitalize">{r.role}</span> },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Last login", render: (r) => formatDate(r.last_login_at) },
            {
              header: "",
              align: "right",
              render: (r) => (
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
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
