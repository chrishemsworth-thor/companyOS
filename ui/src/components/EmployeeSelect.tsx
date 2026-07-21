import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import type { Employee } from "../api/types";

/** Employee picker fed by /v1/people/employees; optional, so "None" clears it. */
export function EmployeeSelect({
  value,
  onChange,
  exclude,
  disabled,
  placeholder = "None",
}: {
  value: string;
  onChange: (employeeId: string) => void;
  /** Employee id to hide (e.g. the employee being edited can't manage themselves). */
  exclude?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["employees"],
    queryFn: () => client!.get<{ employees: Employee[] }>("/v1/people/employees?limit=200"),
    enabled: !!client,
  });

  return (
    <select
      className="input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || query.isLoading}
    >
      <option value="">{query.isLoading ? "Loading employees…" : placeholder}</option>
      {query.data?.employees
        .filter((e) => e.employee_id !== exclude)
        .map((e) => (
          <option key={e.employee_id} value={e.employee_id}>
            {e.name}
            {e.job_title ? ` — ${e.job_title}` : ""}
          </option>
        ))}
    </select>
  );
}
