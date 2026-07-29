import { FormRow } from "./FormRow";
import { ROLES, ROLE_SUMMARY, type Role } from "../lib/roles";

/**
 * The one platform-role picker, shared by the user form and the employee
 * invite. It shows what each role actually grants, because the role decides
 * real access now — before PRD-008 every option granted the same thing, which
 * made the control quietly misleading.
 */
export function RoleSelect({
  value,
  onChange,
  label = "Platform role",
}: {
  value: Role;
  onChange: (role: Role) => void;
  label?: string;
}) {
  return (
    <FormRow label={label}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as Role)}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <p className="mt-1.5 mb-0 text-xs text-muted">{ROLE_SUMMARY[value]}</p>
    </FormRow>
  );
}
