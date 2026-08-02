import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "../Modal";
import { FormRow } from "../FormRow";
import { FormError } from "../FormError";
import { Button } from "../Button";
import { ModalActions } from "../ModalActions";
import { useApiMutation } from "../../hooks/useApiMutation";
import type {
  AccrualMethod,
  AdminLeaveType,
  EmploymentType,
  LeavePolicy,
  PolicyBand,
  StatutoryMinimum,
} from "../../api/types";

/**
 * Create or edit an entitlement policy (PRD-006b).
 *
 * A policy answers three questions, and the form is grouped to match them
 * rather than to match the table: how many days (bands), when they land
 * (accrual), and what happens to the leftovers (carry-forward).
 *
 * The server accepts a whole `bands` array on both create and PATCH — there is
 * no per-band endpoint — so the editor holds the full set in local state and
 * submits it entire. That also means a band removed here is removed by being
 * absent, which is why `bands` is validated as non-empty before submit rather
 * than letting the server 422 on it.
 */

const ACCRUAL_LABELS: Record<AccrualMethod, string> = {
  annual_upfront: "Granted upfront",
  monthly_accrual: "Accrued monthly",
  on_anniversary: "Granted on work anniversary",
};

const ACCRUAL_HINTS: Record<AccrualMethod, string> = {
  annual_upfront:
    "The full entitlement is available on 1 January, pro-rated for anyone who joins mid-year.",
  monthly_accrual:
    "Earned month by month and credited when each month completes — 24 days a year is 2 days " +
    "per completed month, so somebody who has worked January to March can book 6 days on 1 April.",
  on_anniversary:
    "The leave year runs from the employee's own start date rather than the calendar year, and " +
    "the full entitlement is granted on day one of it.",
};

const EMPLOYMENT_TYPES: { value: EmploymentType | ""; label: string }[] = [
  { value: "", label: "Everyone" },
  { value: "full_time", label: "Full time" },
  { value: "part_time", label: "Part time" },
  { value: "contract", label: "Contract" },
  { value: "intern", label: "Intern" },
];

/** A band being edited. Strings, because a half-typed number field is a string. */
interface DraftBand {
  employment_type: EmploymentType | "";
  min_months_service: string;
  max_months_service: string;
  entitlement_days: string;
}

function toDraft(band: PolicyBand): DraftBand {
  return {
    employment_type: band.employment_type ?? "",
    min_months_service: String(band.min_months_service),
    max_months_service: band.max_months_service === null ? "" : String(band.max_months_service),
    entitlement_days: String(band.entitlement_days),
  };
}

const BLANK_BAND: DraftBand = {
  employment_type: "",
  min_months_service: "0",
  max_months_service: "",
  entitlement_days: "",
};

export function LeavePolicyFormModal({
  leaveType,
  existing,
  statutory,
  onClose,
}: {
  leaveType: AdminLeaveType;
  existing?: LeavePolicy;
  /** The Employment Act floor for this leave type, when one exists. */
  statutory?: StatutoryMinimum;
  onClose: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? `${leaveType.name} policy`);
  const [accrual, setAccrual] = useState<AccrualMethod>(
    existing?.accrual_method ?? "annual_upfront",
  );
  const [isDefault, setIsDefault] = useState(existing?.is_default ?? true);

  // Carry-forward, as two independent settings: how many days may roll over,
  // and how long the employee has to use them.
  const [carryDays, setCarryDays] = useState(String(existing?.carry_forward_max_days ?? 0));
  const [carryExpires, setCarryExpires] = useState(
    existing ? existing.carry_forward_expiry_months !== null : false,
  );
  const [carryMonths, setCarryMonths] = useState(
    String(existing?.carry_forward_expiry_months ?? 3),
  );

  const [bands, setBands] = useState<DraftBand[]>(
    existing && existing.bands.length > 0 ? existing.bands.map(toDraft) : [{ ...BLANK_BAND }],
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useApiMutation({
    mutationFn: (client, body: Record<string, unknown>) =>
      existing
        ? client.patch<{ policy: LeavePolicy }>(
            `/v1/people/leave/policies/${existing.policy_id}`,
            body,
          )
        : client.post<{ policy: LeavePolicy }>("/v1/people/leave/policies", body),
    invalidates: () => [["leave-policies"], ["leave-admin-types"]],
    onSuccess: () => onClose(),
  });

  const setBand = (index: number, patch: Partial<DraftBand>) =>
    setBands((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));

  const carryEnabled = Number(carryDays) > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);

    const parsed = bands.map((b) => ({
      employment_type: b.employment_type === "" ? null : b.employment_type,
      min_months_service: Number(b.min_months_service || 0),
      max_months_service: b.max_months_service === "" ? null : Number(b.max_months_service),
      entitlement_days: Number(b.entitlement_days),
    }));

    if (parsed.some((b) => !Number.isFinite(b.entitlement_days))) {
      setLocalError("Every band needs a number of days.");
      return;
    }
    // The server enforces this too, but a CHECK violation comes back as a 422
    // naming a column, which is not something to show an HR administrator.
    const bad = parsed.find(
      (b) => b.max_months_service !== null && b.max_months_service <= b.min_months_service,
    );
    if (bad) {
      setLocalError(
        `A band's "up to" months must be greater than its "from" months (${bad.min_months_service} → ${bad.max_months_service}).`,
      );
      return;
    }

    mutation.mutate({
      ...(existing ? {} : { leave_type_id: leaveType.leave_type_id }),
      name: name.trim(),
      accrual_method: accrual,
      carry_forward_max_days: Number(carryDays || 0),
      // Null means "never lapses", which is also what the server stores when
      // carry-forward is off entirely — there is nothing to expire.
      carry_forward_expiry_months:
        carryEnabled && carryExpires ? Number(carryMonths || 1) : null,
      is_default: isDefault,
      bands: parsed,
    });
  }

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : `New ${leaveType.name.toLowerCase()} policy`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <FormRow label="Policy name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </FormRow>

        {/* ---- Entitlement ------------------------------------------------ */}
        <fieldset className="mt-4 rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Entitlement
          </legend>
          <p className="mb-3 text-sm text-subtle">
            Days per year, by length of service. Add a band for each step — a band naming an
            employment type wins over one that applies to everyone.
          </p>
          {statutory && (
            <p className="mb-3 text-sm text-subtle">
              Employment Act 1955 minimum:{" "}
              {statutory.bands
                .map(
                  (b) =>
                    `${b.days} days ${
                      b.max_months === null
                        ? `after ${b.min_months / 12} years`
                        : `for ${b.min_months / 12}–${b.max_months / 12} years`
                    }`,
                )
                .join(", ")}
              . Saving below it is allowed and warns rather than blocks.
            </p>
          )}

          {bands.map((band, i) => (
            <div key={i} className="mb-2 rounded-md border border-border bg-surface-2 p-3">
              {/* Two rows rather than one: at the dialog's width, four controls
                  and a delete button on a single line squeezes every field to
                  the point where the labels wrap into each other. */}
              <div className="flex items-end gap-2">
                <label className="form-row min-w-0 flex-1">
                  <span className="field-label">Applies to</span>
                  <select
                    className="input"
                    value={band.employment_type}
                    onChange={(e) =>
                      setBand(i, { employment_type: e.target.value as EmploymentType | "" })
                    }
                  >
                    {EMPLOYMENT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove band ${i + 1}`}
                  disabled={bands.length === 1}
                  onClick={() => setBands((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <label className="form-row min-w-0">
                  <span className="field-label">From (months)</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={band.min_months_service}
                    onChange={(e) => setBand(i, { min_months_service: e.target.value })}
                  />
                </label>
                <label className="form-row min-w-0">
                  <span className="field-label">Up to</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    placeholder="No limit"
                    value={band.max_months_service}
                    onChange={(e) => setBand(i, { max_months_service: e.target.value })}
                  />
                </label>
                <label className="form-row min-w-0">
                  <span className="field-label">Days / year</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step="0.5"
                    value={band.entitlement_days}
                    onChange={(e) => setBand(i, { entitlement_days: e.target.value })}
                    required
                  />
                </label>
              </div>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            icon={<Plus className="size-4" />}
            onClick={() => setBands((prev) => [...prev, { ...BLANK_BAND }])}
          >
            Add band
          </Button>
        </fieldset>

        {/* ---- Accrual ---------------------------------------------------- */}
        <fieldset className="mt-4 rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
            When the days land
          </legend>
          <FormRow label="Accrual">
            <select
              className="input"
              value={accrual}
              onChange={(e) => setAccrual(e.target.value as AccrualMethod)}
            >
              {(Object.keys(ACCRUAL_LABELS) as AccrualMethod[]).map((m) => (
                <option key={m} value={m}>
                  {ACCRUAL_LABELS[m]}
                </option>
              ))}
            </select>
          </FormRow>
          <p className="mt-2 text-sm text-subtle">{ACCRUAL_HINTS[accrual]}</p>
        </fieldset>

        {/* ---- Carry-forward ---------------------------------------------- */}
        <fieldset className="mt-4 rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Carry-forward
          </legend>
          <FormRow label="Days that may carry into next year">
            <input
              className="input"
              type="number"
              min={0}
              step="0.5"
              value={carryDays}
              onChange={(e) => setCarryDays(e.target.value)}
            />
          </FormRow>
          <p className="mt-1 text-sm text-subtle">
            {carryEnabled
              ? `Unused days above ${carryDays} are forfeited at year end.`
              : "Zero means nothing carries — unused days are forfeited at year end."}
          </p>

          {carryEnabled && (
            <>
              <label className="mt-3 flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={carryExpires}
                  onChange={(e) => setCarryExpires(e.target.checked)}
                />
                Carried days expire if unused
              </label>
              {carryExpires && (
                <FormRow label="Months into the new year before they lapse">
                  <select
                    className="input"
                    value={carryMonths}
                    onChange={(e) => setCarryMonths(e.target.value)}
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={m}>
                        {m} {m === 1 ? "month" : "months"}
                        {m === 3 ? " — use by 31 March" : ""}
                      </option>
                    ))}
                  </select>
                </FormRow>
              )}
              <p className="mt-1 text-sm text-subtle">
                Carried days are always spent before the new year's entitlement, so an expiry
                takes the leftovers rather than the days just granted.
              </p>
            </>
          )}
        </fieldset>

        <label className="mt-4 flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          Apply to everyone without a specific assignment
        </label>

        {localError && (
          <p role="alert" className="mt-2 text-sm font-medium text-bad">
            {localError}
          </p>
        )}
        <FormError error={mutation.error} />
        <ModalActions>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : existing ? "Save changes" : "Create policy"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
