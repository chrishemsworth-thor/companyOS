import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState, EmptyState } from "../../components/AsyncState";
import { Field } from "../../components/Field";
import { DetailGrid } from "../../components/DetailGrid";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { formatDate } from "../../lib/format";
import { ROLE_SUMMARY } from "../../lib/roles";
import { departmentLabel } from "../people/EmployeeList";
import type { Employee } from "../../api/types";

/** The self view drops HR's `notes`, so the shape is narrower than Employee. */
type SelfEmployee = Omit<Employee, "notes">;

/**
 * The employee's own record — the landing page for the self-service tier, and
 * where PRD-006's leave balance and claim history will hang.
 *
 * Reads GET /v1/me/employee, which resolves ownership from the session rather
 * than a path parameter, so this page works for every role without any of them
 * gaining access to the People directory.
 */
export function MyProfile() {
  const { client, user } = useAuth();
  const query = useQuery({
    queryKey: ["me", "employee"],
    queryFn: () => client!.get<{ employee: SelfEmployee }>("/v1/me/employee"),
    enabled: !!client,
  });

  const notLinked = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div>
      <PageHeader title="My profile" />

      <DetailGrid>
        <Field label="Signed in as">{user?.email ?? "—"}</Field>
        <Field label="Platform role">
          <span className="capitalize">{user?.role ?? "—"}</span>
        </Field>
      </DetailGrid>
      {user && <p className="mt-2 mb-0 text-xs text-muted">{ROLE_SUMMARY[user.role]}</p>}

      <h2 className="mb-3 mt-8 text-sm font-semibold text-fg">Employee record</h2>
      {query.isLoading && <LoadingState />}
      {notLinked && (
        <EmptyState>
          This login isn't linked to an employee record yet. Ask an administrator to link it from
          the employee's Edit form.
        </EmptyState>
      )}
      {query.error && !notLinked && <ErrorState error={query.error} />}
      {query.data && (
        <DetailGrid>
          <Field label="Name">{query.data.employee.name}</Field>
          <Field label="Status">
            <StatusBadge status={query.data.employee.status} />
          </Field>
          <Field label="Job title">{query.data.employee.job_title ?? "—"}</Field>
          <Field label="Department">{departmentLabel(query.data.employee.department_id)}</Field>
          <Field label="Employment">
            {query.data.employee.employment_type.replace(/_/g, " ")}
          </Field>
          <Field label="Work email">{query.data.employee.email ?? "—"}</Field>
          <Field label="Phone">{query.data.employee.phone ?? "—"}</Field>
          <Field label="Location">{query.data.employee.location ?? "—"}</Field>
          <Field label="Start date">
            {query.data.employee.start_date ? formatDate(query.data.employee.start_date) : "—"}
          </Field>
        </DetailGrid>
      )}
    </div>
  );
}
