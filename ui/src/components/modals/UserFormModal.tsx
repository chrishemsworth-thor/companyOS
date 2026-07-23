import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";
import { InvitePanel, type InviteInfo } from "../InvitePanel";

export const USER_ROLES = ["admin", "operator", "finance", "support", "readonly"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface AdminUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  /** `invited` = created without a password, waiting on the invite link. */
  status: "active" | "disabled" | "invited";
  created_at: string;
  last_login_at: string | null;
}

interface CreateUserResponse {
  user: AdminUser;
  invite: InviteInfo;
}

/**
 * Create a user, or edit role/status/name when `existing` is passed. Creation
 * is passwordless: the server issues a single-use invite (emailed when the
 * tenant has an email transport) and the modal shows the outcome, including
 * the copyable invite link.
 */
export function UserFormModal({
  existing,
  onClose,
}: {
  existing?: AdminUser;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(existing?.email ?? "");
  const [displayName, setDisplayName] = useState(existing?.display_name ?? "");
  const [role, setRole] = useState<UserRole>(existing?.role ?? "operator");
  const [status, setStatus] = useState<"active" | "disabled">(
    existing?.status === "disabled" ? "disabled" : "active",
  );
  const [created, setCreated] = useState<CreateUserResponse | null>(null);

  const mutation = useApiMutation({
    mutationFn: (client, body: Record<string, unknown>): Promise<AdminUser | CreateUserResponse> =>
      existing
        ? client.patch<AdminUser>(`/v1/users/${existing.user_id}`, body)
        : client.post<CreateUserResponse>("/v1/users", body),
    invalidates: () => [["users"]],
    onSuccess: (data) => {
      if ("invite" in data) setCreated(data);
      else onClose();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (existing) {
      mutation.mutate({ display_name: displayName.trim() || undefined, role, status });
    } else {
      mutation.mutate({
        email: email.trim(),
        display_name: displayName.trim() || undefined,
        role,
      });
    }
  };

  if (created) {
    return (
      <Modal title={`Invite ${created.user.email}`} onClose={onClose}>
        <InvitePanel email={created.user.email} invite={created.invite} />
        <ModalActions>
          <Button type="button" variant="primary" onClick={onClose}>
            Done
          </Button>
        </ModalActions>
      </Modal>
    );
  }

  return (
    <Modal title={existing ? `Edit ${existing.email}` : "New user"} onClose={onClose}>
      <form onSubmit={submit}>
        {!existing && (
          <FormRow label="Email">
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </FormRow>
        )}
        <FormRow label="Display name (optional)">
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </FormRow>
        <FormRow label="Role">
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </FormRow>
        {existing && (
          <FormRow label="Status">
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as "active" | "disabled")}
            >
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </FormRow>
        )}
        {!existing && (
          <p className="mt-1 text-xs text-muted">
            They'll receive a single-use invite link to set their own password.
          </p>
        )}
        <FormError error={mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : existing ? "Save changes" : "Create & invite"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
