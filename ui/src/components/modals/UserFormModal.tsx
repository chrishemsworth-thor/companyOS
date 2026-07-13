import { useState } from "react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { useApiMutation } from "../../hooks/useApiMutation";

export const USER_ROLES = ["admin", "operator", "finance", "support", "readonly"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface AdminUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  status: "active" | "disabled";
  created_at: string;
  last_login_at: string | null;
}

/** Create a user, or edit role/status/name when `existing` is passed. */
export function UserFormModal({
  existing,
  onClose,
}: {
  existing?: AdminUser;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(existing?.email ?? "");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState(existing?.display_name ?? "");
  const [role, setRole] = useState<UserRole>(existing?.role ?? "operator");
  const [status, setStatus] = useState<"active" | "disabled">(existing?.status ?? "active");

  const mutation = useApiMutation({
    mutationFn: (client, body: Record<string, unknown>) =>
      existing
        ? client.patch<AdminUser>(`/v1/users/${existing.user_id}`, body)
        : client.post<AdminUser>("/v1/users", body),
    invalidates: () => [["users"]],
    onSuccess: () => onClose(),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (existing) {
      mutation.mutate({ display_name: displayName.trim() || undefined, role, status });
    } else {
      mutation.mutate({
        email: email.trim(),
        password,
        display_name: displayName.trim() || undefined,
        role,
      });
    }
  };

  return (
    <Modal title={existing ? `Edit ${existing.email}` : "New user"} onClose={onClose}>
      <form onSubmit={submit}>
        {!existing && (
          <>
            <FormRow label="Email">
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </FormRow>
            <FormRow label="Temporary password (min 8 chars)">
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </FormRow>
          </>
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
        <FormError error={mutation.error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : existing ? "Save changes" : "Create user"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
