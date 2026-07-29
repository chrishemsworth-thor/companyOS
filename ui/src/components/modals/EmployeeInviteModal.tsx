import { useState } from "react";
import { Modal } from "../Modal";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { InvitePanel, type InviteInfo } from "../InvitePanel";
import { useApiMutation } from "../../hooks/useApiMutation";
import { RoleSelect } from "../RoleSelect";
import { DEFAULT_ROLE, type Role } from "../../lib/roles";
import type { Employee } from "../../api/types";

interface InviteResponse {
  employee: Employee;
  invite: InviteInfo;
}

/**
 * Grant an employee console access: pick the platform role, then the server
 * creates the linked login and emails a single-use invite. Also used to resend
 * while the login is still pending.
 */
export function EmployeeInviteModal({
  employee,
  onClose,
}: {
  employee: Employee;
  onClose: () => void;
}) {
  // Least privilege by default: granting business access is a deliberate
  // choice the admin makes here, not something an invite hands out silently.
  const [role, setRole] = useState<Role>(DEFAULT_ROLE);
  const [result, setResult] = useState<InviteInfo | null>(null);
  const pending = employee.user_id !== null;

  const mutation = useApiMutation({
    mutationFn: (client, body: { role?: Role }) =>
      client.post<InviteResponse>(`/v1/people/employees/${employee.employee_id}/invite`, body),
    invalidates: () => [["employees", employee.employee_id], ["employees"], ["users"]],
    onSuccess: (data) => setResult(data.invite),
    errorTitle: "Could not send invite",
  });

  if (result) {
    return (
      <Modal title={`Invite ${employee.name}`} onClose={onClose}>
        <InvitePanel email={employee.email ?? ""} invite={result} />
        <ModalActions>
          <Button type="button" variant="primary" onClick={onClose}>
            Done
          </Button>
        </ModalActions>
      </Modal>
    );
  }

  return (
    <Modal
      title={pending ? `Resend invite to ${employee.name}` : `Invite ${employee.name} to the platform`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Re-inviting an existing pending login keeps its current role.
          mutation.mutate(pending ? {} : { role });
        }}
      >
        <p className="mt-0 mb-4 text-sm text-muted">
          {pending ? (
            <>
              A login already exists for <strong>{employee.email}</strong> but hasn't been activated
              yet. This issues a new invite link and invalidates the previous one.
            </>
          ) : (
            <>
              Creates a console login for <strong>{employee.email}</strong> and emails a single-use
              link to set their own password.
            </>
          )}
        </p>
        {!pending && <RoleSelect value={role} onChange={setRole} />}
        <FormError error={mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Sending…" : pending ? "Resend invite" : "Create login & invite"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
