import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Plus, Check } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { Button } from "../../components/Button";
import { CompanyProfileForm } from "../../components/CompanyProfileForm";
import { TeamFormModal } from "../../components/modals/TeamFormModal";
import { EmployeeFormModal } from "../../components/modals/EmployeeFormModal";
import { useApiMutation } from "../../hooks/useApiMutation";
import { departmentLabel } from "../people/EmployeeList";
import { cn } from "../../lib/cn";
import type { Employee, Team } from "../../api/types";

const STEPS = ["Company profile", "Teams", "Employees"] as const;

/**
 * First-run setup journey for a newly provisioned company: profile (required
 * once) → teams → employees. Teams/employees are skippable — both "Finish" and
 * "Skip" mark the tenant onboarded, so the console stops redirecting here and
 * the remaining setup continues on the normal pages.
 */
export function Onboarding() {
  const { tenant, markOnboarded } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [addingTeam, setAddingTeam] = useState(false);
  const [addingEmployee, setAddingEmployee] = useState(false);

  const complete = useApiMutation({
    mutationFn: (client) => client.post<{ onboarded_at: string }>("/v1/settings/onboarding/complete"),
    invalidates: () => [],
    successMessage: `Welcome to CompanyOS${tenant ? `, ${tenant.name}` : ""}!`,
    onSuccess: () => {
      markOnboarded();
      navigate("/", { replace: true });
    },
  });

  return (
    <div style={{ maxWidth: 720 }} className="mx-auto">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Set up {tenant?.name ?? "your company"}</h1>
        <Button variant="ghost" loading={complete.isPending} onClick={() => complete.mutate(undefined)}>
          Skip setup for now
        </Button>
      </div>
      <p className="mb-6 text-sm text-muted">
        Three quick steps to get your company ready. You can finish teams and employees later from
        the People pages.
      </p>

      <ol className="mb-8 flex gap-2">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border text-xs",
                i < step && "border-accent bg-accent text-accent-contrast",
                i === step && "border-accent text-fg",
                i > step && "border-border-strong text-muted",
              )}
            >
              {i < step ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("text-sm", i === step ? "text-fg" : "text-muted")}>{label}</span>
            {i < STEPS.length - 1 && <span className="mx-2 text-muted">—</span>}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <section>
          <p className="mb-4 text-sm text-muted">
            Your company's legal identity and base currency. This appears on quotes and invoices.
          </p>
          <CompanyProfileForm submitLabel="Save & continue" onSaved={() => setStep(1)} />
        </section>
      )}

      {step === 1 && (
        <OnboardingTeams
          onAdd={() => setAddingTeam(true)}
          onBack={() => setStep(0)}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <OnboardingEmployees
          onAdd={() => setAddingEmployee(true)}
          onBack={() => setStep(1)}
          onFinish={() => complete.mutate(undefined)}
          finishing={complete.isPending}
        />
      )}

      {addingTeam && <TeamFormModal onClose={() => setAddingTeam(false)} />}
      {addingEmployee && <EmployeeFormModal onClose={() => setAddingEmployee(false)} />}
    </div>
  );
}

function OnboardingTeams({
  onAdd,
  onBack,
  onNext,
}: {
  onAdd: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["teams"],
    queryFn: () => client!.get<{ teams: Team[] }>("/v1/people/teams"),
    enabled: !!client,
  });
  const teams = query.data?.teams ?? [];

  return (
    <section>
      <p className="mb-4 text-sm text-muted">
        Group your people into teams (Engineering, Sales, Finance…). Optional — you can also do
        this later under People → Teams.
      </p>
      <ul className="mb-4">
        {teams.map((t) => (
          <li key={t.team_id} className="flex items-center gap-2 border-b border-border py-2 text-sm">
            <Check className="size-4 text-accent" />
            <span>{t.name}</span>
            <span className="text-muted">{departmentLabel(t.department_id)}</span>
          </li>
        ))}
      </ul>
      <Button icon={<Plus className="size-4" />} onClick={onAdd}>
        Add a team
      </Button>
      <div className="mt-8 flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={onNext}>
          {teams.length > 0 ? "Continue" : "Skip for now"}
        </Button>
      </div>
    </section>
  );
}

function OnboardingEmployees({
  onAdd,
  onBack,
  onFinish,
  finishing,
}: {
  onAdd: () => void;
  onBack: () => void;
  onFinish: () => void;
  finishing: boolean;
}) {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ["employees"],
    queryFn: () => client!.get<{ employees: Employee[] }>("/v1/people/employees?limit=200"),
    enabled: !!client,
  });
  const employees = query.data?.employees ?? [];

  return (
    <section>
      <p className="mb-4 text-sm text-muted">
        Add your people. Optional — you can also do this later under People → Employees.
      </p>
      <ul className="mb-4">
        {employees.map((e) => (
          <li key={e.employee_id} className="flex items-center gap-2 border-b border-border py-2 text-sm">
            <Check className="size-4 text-accent" />
            <span>{e.name}</span>
            <span className="text-muted">{e.job_title ?? departmentLabel(e.department_id)}</span>
          </li>
        ))}
      </ul>
      <Button icon={<Plus className="size-4" />} onClick={onAdd}>
        Add an employee
      </Button>
      <div className="mt-8 flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" loading={finishing} onClick={onFinish}>
          {employees.length > 0 ? "Finish setup" : "Skip & finish"}
        </Button>
      </div>
    </section>
  );
}
