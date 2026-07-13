import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState } from "../components/AsyncState";
import { DataTable } from "../components/DataTable";
import { StatusBadge } from "../components/StatusBadge";
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
      <div className="page-header">
        <h1>Users</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          New user
        </button>
      </div>
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
            { header: "Role", render: (r) => r.role },
            { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { header: "Last login", render: (r) => formatDate(r.last_login_at) },
            {
              header: "",
              align: "right",
              render: (r) => (
                <button className="link-button" onClick={() => setEditing(r)}>
                  Edit
                </button>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
