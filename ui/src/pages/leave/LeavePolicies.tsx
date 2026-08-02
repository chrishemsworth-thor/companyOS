import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Pencil } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { CanWrite } from "../../components/CanWrite";
import { LeavePolicyFormModal } from "../../components/modals/LeavePolicyFormModal";
import type {
  AccrualMethod,
  AdminLeaveType,
  LeavePolicy,
  PolicyBand,
  StatutoryMinimum,
} from "../../api/types";

/**
 * Leave policy configuration (PRD-006b), grouped by leave type.
 *
 * The HR half of leave, and until this screen existed the only half with no
 * console at all: the engine has shipped entitlement bands, three accrual
 * methods and carry-forward with an expiry since S6, and every one of them was
 * reachable only by curl.
 *
 * Grouped by leave type rather than listing policies flat, because "how much
 * annual leave do we give?" is the question people arrive with, and a policy on
 * its own does not answer it — a type with no default policy is the actual
 * failure mode (every employee reads as unconfigured), and grouping is what
 * makes that visible instead of merely absent.
 */

const ACCRUAL_LABELS: Record<AccrualMethod, string> = {
  annual_upfront: "Granted upfront",
  monthly_accrual: "Accrued monthly",
  on_anniversary: "On work anniversary",
};

const EMPLOYMENT_LABELS: Record<string, string> = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
  intern: "Intern",
};

/** "12 days" · "8 days (interns)" · "12 days after 2 years". */
function bandSummary(band: PolicyBand): string {
  const days = `${band.entitlement_days} ${band.entitlement_days === 1 ? "day" : "days"}`;
  const who = band.employment_type ? ` (${EMPLOYMENT_LABELS[band.employment_type]})` : "";
  const years = (months: number) => {
    const y = months / 12;
    return Number.isInteger(y) ? `${y} ${y === 1 ? "year" : "years"}` : `${months} months`;
  };
  if (band.min_months_service === 0 && band.max_months_service === null) {
    return `${days}${who}`;
  }
  if (band.max_months_service === null) {
    return `${days}${who} after ${years(band.min_months_service)}`;
  }
  return `${days}${who} for ${years(band.min_months_service)}–${years(band.max_months_service)}`;
}

function carrySummary(policy: LeavePolicy): string {
  if (policy.carry_forward_max_days <= 0) return "No carry-forward";
  const days = `${policy.carry_forward_max_days} ${policy.carry_forward_max_days === 1 ? "day" : "days"}`;
  return policy.carry_forward_expiry_months === null
    ? `Carries ${days}, no expiry`
    : `Carries ${days}, expires after ${policy.carry_forward_expiry_months} ${
        policy.carry_forward_expiry_months === 1 ? "month" : "months"
      }`;
}

export function LeavePolicies() {
  const { client } = useAuth();
  const [creatingFor, setCreatingFor] = useState<AdminLeaveType | null>(null);
  const [editing, setEditing] = useState<{ type: AdminLeaveType; policy: LeavePolicy } | null>(null);

  const typesQuery = useQuery({
    queryKey: ["leave-admin-types"],
    queryFn: () => client!.get<{ leave_types: AdminLeaveType[] }>("/v1/people/leave/types"),
    enabled: !!client,
  });
  const policiesQuery = useQuery({
    queryKey: ["leave-policies"],
    queryFn: () => client!.get<{ policies: LeavePolicy[] }>("/v1/people/leave/policies"),
    enabled: !!client,
  });
  const statutoryQuery = useQuery({
    queryKey: ["leave-statutory"],
    queryFn: () =>
      client!.get<{ statutory_minimums: StatutoryMinimum[] }>(
        "/v1/people/leave/statutory-minimums",
      ),
    enabled: !!client,
  });

  const types = typesQuery.data?.leave_types ?? [];
  const policies = policiesQuery.data?.policies ?? [];
  const statutoryFor = (basis: string | null) =>
    basis
      ? statutoryQuery.data?.statutory_minimums.find((s) => s.basis === basis)
      : undefined;

  const isLoading = typesQuery.isLoading || policiesQuery.isLoading;
  const error = typesQuery.error ?? policiesQuery.error;

  return (
    <div>
      <PageHeader title="Leave policies" />
      <p className="mb-4 max-w-3xl text-sm text-muted">
        How much leave each kind grants, when it lands, and what happens to unused days at year
        end. An employee with no specific assignment gets the policy marked <em>default</em> for
        that type — so a type with no default policy leaves everybody on it unconfigured.
      </p>

      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} />}

      {!isLoading && !error && (
        <div className="flex flex-col gap-4">
          {types
            .filter((t) => t.archived_at === null)
            .map((type) => {
              const forType = policies.filter(
                (p) => p.leave_type_id === type.leave_type_id && p.archived_at === null,
              );
              const hasDefault = forType.some((p) => p.is_default);
              return (
                <section
                  key={type.leave_type_id}
                  className="rounded-xl border border-border bg-surface p-4 shadow-sm"
                >
                  <header className="flex flex-wrap items-start justify-between gap-2">
                    {/* `flex-1` so a long type name uses the space rather than
                        crowding the action, `min-w-0` so it can still shrink. */}
                    <div className="min-w-0 flex-1">
                      {/* `m-0` is load-bearing: this project's reset does not
                          strip heading margins (see Modal.tsx, same fix), and the
                          default top margin drops the title a line below the
                          action button it is supposed to sit level with. */}
                      <h2 className="m-0 text-base font-semibold tracking-tight text-fg">
                        {type.name}
                      </h2>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-subtle">
                        <code className="text-xs">{type.code}</code>
                        {!type.is_paid && <Badge tone="neutral">Unpaid</Badge>}
                        {type.requires_attachment && (
                          <Badge tone="neutral">Document required</Badge>
                        )}
                      </div>
                    </div>
                    <CanWrite module="people">
                      <Button
                        size="sm"
                        icon={<Plus className="size-4" />}
                        onClick={() => setCreatingFor(type)}
                      >
                        Add policy
                      </Button>
                    </CanWrite>
                  </header>

                  {forType.length === 0 ? (
                    <p className="mt-3 rounded-md bg-bad-bg px-3 py-2 text-sm text-bad">
                      No policy — every employee reads as unconfigured for {type.name.toLowerCase()}{" "}
                      and cannot use it.
                    </p>
                  ) : (
                    <ul className="mt-3 flex flex-col gap-2">
                      {forType.map((policy) => (
                        <li
                          key={policy.policy_id}
                          className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-fg">{policy.name}</span>
                              {policy.is_default && <Badge tone="good">Default</Badge>}
                            </div>
                            <div className="mt-1 text-sm text-subtle">
                              {policy.bands.map(bandSummary).join(" · ")}
                            </div>
                            <div className="mt-0.5 text-sm text-subtle">
                              {ACCRUAL_LABELS[policy.accrual_method]} · {carrySummary(policy)}
                            </div>
                          </div>
                          <CanWrite module="people">
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Pencil className="size-4" />}
                              onClick={() => setEditing({ type, policy })}
                            >
                              Edit
                            </Button>
                          </CanWrite>
                        </li>
                      ))}
                    </ul>
                  )}

                  {forType.length > 0 && !hasDefault && (
                    <p className="mt-2 text-sm text-bad">
                      None of these is the default, so they apply only to employees assigned to
                      them individually.
                    </p>
                  )}
                </section>
              );
            })}
        </div>
      )}

      {creatingFor && (
        <LeavePolicyFormModal
          leaveType={creatingFor}
          statutory={statutoryFor(creatingFor.statutory_basis)}
          onClose={() => setCreatingFor(null)}
        />
      )}
      {editing && (
        <LeavePolicyFormModal
          leaveType={editing.type}
          existing={editing.policy}
          statutory={statutoryFor(editing.type.statutory_basis)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
