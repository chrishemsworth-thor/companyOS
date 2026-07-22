import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { LoadingState, ErrorState } from "./AsyncState";
import { FormRow } from "./FormRow";
import { FormError } from "./FormError";
import { Button } from "./Button";
import { CurrencySelect } from "./CurrencySelect";
import { useApiMutation } from "../hooks/useApiMutation";
import type { CompanyProfile as CompanyProfileType } from "../api/types";

type Form = Record<keyof CompanyProfileType, string>;

const EMPTY: Form = {
  legal_name: "",
  reg_no: "",
  tax_no: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  postcode: "",
  country: "",
  phone: "",
  email: "",
  website: "",
  default_prepared_by: "",
  base_currency: "MYR",
};

/**
 * The company profile form, shared by the settings page and onboarding step 1.
 * Owns its own fetch + save; `onSaved` fires after a successful save so the
 * wizard can advance.
 */
export function CompanyProfileForm({
  submitLabel = "Save profile",
  onSaved,
}: {
  submitLabel?: string;
  onSaved?: () => void;
}) {
  const { client } = useAuth();
  const [form, setForm] = useState<Form>(EMPTY);

  const query = useQuery({
    queryKey: ["settings", "company-profile"],
    queryFn: () => client!.get<{ company_profile: CompanyProfileType | null }>("/v1/settings/company-profile"),
    enabled: !!client,
  });

  useEffect(() => {
    const p = query.data?.company_profile;
    if (p) {
      setForm(
        Object.fromEntries(Object.keys(EMPTY).map((k) => [k, p[k as keyof CompanyProfileType] ?? ""])) as Form,
      );
    }
  }, [query.data]);

  const mutation = useApiMutation({
    mutationFn: (apiClient, body: Record<string, string | null>) =>
      apiClient.put<CompanyProfileType>("/v1/settings/company-profile", body),
    invalidates: () => [["settings", "company-profile"]],
    successMessage: "Company profile saved",
    onSuccess: () => onSaved?.(),
  });

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Send blanks as null so optional fields clear cleanly.
    const body = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v.trim() === "" ? null : v.trim()]),
    );
    body.legal_name = form.legal_name.trim();
    body.base_currency = form.base_currency || "MYR";
    mutation.mutate(body);
  };

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;

  return (
    <form onSubmit={submit} style={{ maxWidth: 640 }}>
      <FormRow label="Legal name">
        <input className="input" value={form.legal_name} onChange={set("legal_name")} required />
      </FormRow>
      <div className="form-row-inline">
        <FormRow label="Registration no.">
          <input className="input" value={form.reg_no} onChange={set("reg_no")} />
        </FormRow>
        <FormRow label="Tax / SST no.">
          <input className="input" value={form.tax_no} onChange={set("tax_no")} />
        </FormRow>
      </div>
      <FormRow label="Base currency">
        <CurrencySelect
          value={form.base_currency}
          onChange={(code) => setForm((f) => ({ ...f, base_currency: code }))}
        />
      </FormRow>
      <p className="mb-3 text-sm text-muted">
        New invoices, deals, and quotes default to the base currency — each document can still use
        any currency.
      </p>
      <FormRow label="Address line 1">
        <input className="input" value={form.address_line1} onChange={set("address_line1")} />
      </FormRow>
      <FormRow label="Address line 2">
        <input className="input" value={form.address_line2} onChange={set("address_line2")} />
      </FormRow>
      <div className="form-row-inline">
        <FormRow label="City">
          <input className="input" value={form.city} onChange={set("city")} />
        </FormRow>
        <FormRow label="State">
          <input className="input" value={form.state} onChange={set("state")} />
        </FormRow>
      </div>
      <div className="form-row-inline">
        <FormRow label="Postcode">
          <input className="input" value={form.postcode} onChange={set("postcode")} />
        </FormRow>
        <FormRow label="Country">
          <input className="input" value={form.country} onChange={set("country")} />
        </FormRow>
      </div>
      <div className="form-row-inline">
        <FormRow label="Phone">
          <input className="input" value={form.phone} onChange={set("phone")} />
        </FormRow>
        <FormRow label="Email">
          <input className="input" type="email" value={form.email} onChange={set("email")} />
        </FormRow>
      </div>
      <FormRow label="Website">
        <input className="input" value={form.website} onChange={set("website")} />
      </FormRow>
      <FormRow label="Default signatory (prepared by)">
        <input className="input" value={form.default_prepared_by} onChange={set("default_prepared_by")} />
      </FormRow>
      <FormError error={mutation.error} />
      <div className="mt-2">
        <Button type="submit" variant="primary" loading={mutation.isPending} disabled={!form.legal_name.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
