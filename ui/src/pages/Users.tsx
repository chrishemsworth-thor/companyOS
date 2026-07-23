import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState } from "../components/AsyncState";
import { DataTable } from "../components/DataTable";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { ModalActions } from "../components/ModalActions";
import { InvitePanel, type InviteInfo } from "../components/InvitePanel";
import { UserFormModal, type AdminUser } from "../components/modals/UserFormModal";
import { useApiMutation } from "../hooks/useApiMutation";
import { formatDate } from "../lib/format";

export function Users() {
  const { client, user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resent, setResent] = useState<{ email: string; invite: InviteInfo } | null>(null);

  const query = useQuery({
    queryKey: ["users"],
    queryFn: () => client!.get<{ users: AdminUser[] }>("/v1/users"),
    enabled: !!client && user?.role === "admin",
  });

  const resend = useApiMutation({
    mutationFn: (apiClient, target: AdminUser) =>
      apiClient
        .post<{ invite: InviteInfo }>(`/v1/users/${target.user_id}/resend-invite`)
        .then((res) => ({ email: target.email, invite: res.invite })),
    invalidates: () => [["users"]],
    onSuccess: (data) => setResent(data),
    errorTitle: "Could not resend invite",
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
      {resent && (
        <Modal title={`Invite ${resent.email}`} onClose={() => setResent(null)}>
          <InvitePanel email={resent.email} invite={resent.invite} />
          <ModalActions>
            <Button type="button" variant="primary" onClick={() => setResent(null)}>
              Done
            </Button>
          </ModalActions>
        </Modal>
      )}
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
                <span className="inline-flex gap-1">
                  {r.status === "invited" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={resend.isPending && resend.variables?.user_id === r.user_id}
                      onClick={() => resend.mutate(r)}
                    >
                      Resend invite
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                </span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
