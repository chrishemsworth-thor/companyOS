import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { LoadingState, ErrorState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { FormRow } from "../../components/FormRow";
import { FormError } from "../../components/FormError";
import { Button } from "../../components/Button";
import { useApiMutation } from "../../hooks/useApiMutation";
import type { QuoteBranding as QuoteBrandingType } from "../../api/types";

interface Form {
  logo_url: string;
  primary_color: string;
  accent_color: string;
  font_family: string;
  show_discount_column: boolean;
  show_line_notes: boolean;
  show_tax_line: boolean;
  show_signature_block: boolean;
  show_terms: boolean;
  tax_percent: string;
  tax_label: string;
  terms_text: string;
  currency: string;
  number_format: QuoteBrandingType["template_config"]["number_format"];
  date_format: QuoteBrandingType["template_config"]["date_format"];
}

function toForm(b: QuoteBrandingType): Form {
  const t = b.template_config;
  return {
    logo_url: b.logo_url ?? "",
    primary_color: b.primary_color,
    accent_color: b.accent_color,
    font_family: b.font_family,
    show_discount_column: t.show_discount_column,
    show_line_notes: t.show_line_notes,
    show_tax_line: t.show_tax_line,
    show_signature_block: t.show_signature_block,
    show_terms: t.show_terms,
    tax_percent: String(t.tax_rate_bps / 100),
    tax_label: t.tax_label,
    terms_text: t.terms_text,
    currency: t.currency,
    number_format: t.number_format,
    date_format: t.date_format,
  };
}

export function QuoteBranding() {
  const { client } = useAuth();
  const [form, setForm] = useState<Form | null>(null);

  const query = useQuery({
    queryKey: ["settings", "quote-branding"],
    queryFn: () => client!.get<QuoteBrandingType>("/v1/settings/quote-branding"),
    enabled: !!client,
  });

  useEffect(() => {
    if (query.data) setForm(toForm(query.data));
  }, [query.data]);

  const mutation = useApiMutation({
    mutationFn: (apiClient, body: unknown) =>
      apiClient.put<QuoteBrandingType>("/v1/settings/quote-branding", body),
    invalidates: () => [["settings", "quote-branding"]],
    successMessage: "Quote branding saved",
  });

  if (query.isLoading || !form) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} />;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const taxPercent = Number(form.tax_percent);
    mutation.mutate({
      logo_url: form.logo_url.trim() || null,
      primary_color: form.primary_color,
      accent_color: form.accent_color,
      font_family: form.font_family,
      template_config: {
        show_discount_column: form.show_discount_column,
        show_line_notes: form.show_line_notes,
        show_tax_line: form.show_tax_line,
        show_signature_block: form.show_signature_block,
        show_terms: form.show_terms,
        tax_rate_bps: Number.isFinite(taxPercent) ? Math.round(taxPercent * 100) : 0,
        tax_label: form.tax_label,
        terms_text: form.terms_text,
        currency: form.currency,
        number_format: form.number_format,
        date_format: form.date_format,
      },
    });
  };

  const toggle = (label: string, key: keyof Form) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
      <input
        type="checkbox"
        checked={form[key] as boolean}
        onChange={(e) => set(key, e.target.checked as Form[typeof key])}
      />
      {label}
    </label>
  );

  return (
    <div>
      <PageHeader title="Quote Branding" />
      <p className="mb-4 text-sm text-muted">
        Configure how <strong>this company's</strong> quotes look — logo, colours, font, and which columns
        and sections appear. Changes apply to every quote document.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 24 }}>
        <form onSubmit={submit}>
          <FormRow label="Logo URL">
            <input className="input" value={form.logo_url} onChange={(e) => set("logo_url", e.target.value)} placeholder="https://…" />
          </FormRow>
          <div className="form-row-inline">
            <FormRow label="Primary colour">
              <input type="color" className="input" value={form.primary_color} onChange={(e) => set("primary_color", e.target.value)} />
            </FormRow>
            <FormRow label="Accent colour">
              <input type="color" className="input" value={form.accent_color} onChange={(e) => set("accent_color", e.target.value)} />
            </FormRow>
          </div>
          <FormRow label="Font family (CSS)">
            <input className="input" value={form.font_family} onChange={(e) => set("font_family", e.target.value)} />
          </FormRow>

          <div className="field-label" style={{ marginTop: 12 }}>Sections & columns</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "6px 0 12px" }}>
            {toggle("Show discount column", "show_discount_column")}
            {toggle("Show per-line notes", "show_line_notes")}
            {toggle("Show tax line", "show_tax_line")}
            {toggle("Show signature block", "show_signature_block")}
            {toggle("Show terms & conditions", "show_terms")}
          </div>

          <div className="form-row-inline">
            <FormRow label="Tax rate (%)">
              <input className="input" inputMode="decimal" value={form.tax_percent} onChange={(e) => set("tax_percent", e.target.value)} />
            </FormRow>
            <FormRow label="Tax label">
              <input className="input" value={form.tax_label} onChange={(e) => set("tax_label", e.target.value)} />
            </FormRow>
          </div>
          <div className="form-row-inline">
            <FormRow label="Currency">
              <input className="input" value={form.currency} maxLength={3} minLength={3} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
            </FormRow>
            <FormRow label="Number format">
              <select className="input" value={form.number_format} onChange={(e) => set("number_format", e.target.value as Form["number_format"])}>
                <option value="1,234.56">1,234.56</option>
                <option value="1.234,56">1.234,56</option>
              </select>
            </FormRow>
          </div>
          <FormRow label="Date format">
            <select className="input" value={form.date_format} onChange={(e) => set("date_format", e.target.value as Form["date_format"])}>
              <option value="DD/MM/YYYY">DD/MM/YYYY</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              <option value="DD MMM YYYY">DD MMM YYYY</option>
            </select>
          </FormRow>
          {form.show_terms && (
            <FormRow label="Terms & conditions text">
              <textarea className="input" rows={4} value={form.terms_text} onChange={(e) => set("terms_text", e.target.value)} />
            </FormRow>
          )}

          <FormError error={mutation.error} />
          <div className="mt-2">
            <Button type="submit" variant="primary" loading={mutation.isPending}>Save branding</Button>
          </div>
        </form>

        <BrandingPreview form={form} />
      </div>
    </div>
  );
}

/** Lightweight in-page preview mirroring the document header/table/toggles. */
function BrandingPreview({ form }: { form: Form }) {
  return (
    <div>
      <div className="field-label">Live preview</div>
      <div
        style={{
          marginTop: 6,
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 8,
          padding: 20,
          fontFamily: form.font_family,
          background: "#fff",
          color: "#1f2933",
          fontSize: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `3px solid ${form.primary_color}`, paddingBottom: 10, marginBottom: 12 }}>
          {form.logo_url ? (
            <img src={form.logo_url} alt="logo" style={{ maxHeight: 40, maxWidth: 160 }} />
          ) : (
            <div style={{ fontWeight: 700, color: form.primary_color }}>Your Company</div>
          )}
          <div style={{ textAlign: "right" }}>
            <div style={{ fontWeight: 700, color: form.primary_color, letterSpacing: ".04em" }}>QUOTATION</div>
            <div style={{ color: "#6b7280" }}>Q2026-0001</div>
          </div>
        </div>
        <div style={{ color: form.accent_color, fontWeight: 600, textTransform: "uppercase", fontSize: 10 }}>To</div>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Sample Customer Sdn Bhd</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: form.primary_color, color: "#fff", textAlign: "left" }}>
              <th style={{ padding: "4px 6px" }}>Item</th>
              <th style={{ padding: "4px 6px", textAlign: "right" }}>Unit</th>
              {form.show_discount_column && <th style={{ padding: "4px 6px", textAlign: "right" }}>Discount</th>}
              <th style={{ padding: "4px 6px", textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: "4px 6px", borderBottom: "1px solid #e5e7eb" }}>
                Sample service
                {form.show_line_notes && <div style={{ color: "#6b7280", fontStyle: "italic" }}>note</div>}
              </td>
              <td style={{ padding: "4px 6px", textAlign: "right", borderBottom: "1px solid #e5e7eb" }}>100.00</td>
              {form.show_discount_column && <td style={{ padding: "4px 6px", textAlign: "right", borderBottom: "1px solid #e5e7eb" }}>10.00</td>}
              <td style={{ padding: "4px 6px", textAlign: "right", borderBottom: "1px solid #e5e7eb" }}>90.00</td>
            </tr>
          </tbody>
        </table>
        <div style={{ textAlign: "right", marginTop: 8 }}>
          <div>Subtotal: 90.00</div>
          {form.show_tax_line && <div>{form.tax_label}: {(90 * (Number(form.tax_percent) || 0) / 100).toFixed(2)}</div>}
          <div style={{ fontWeight: 700, color: form.primary_color, borderTop: `2px solid ${form.primary_color}`, marginTop: 4, paddingTop: 4 }}>
            Total: {(90 + 90 * (form.show_tax_line ? Number(form.tax_percent) || 0 : 0) / 100).toFixed(2)}
          </div>
        </div>
        {form.show_signature_block && (
          <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
            {["Prepared By", "Approved By", "Customer"].map((r) => (
              <div key={r} style={{ flex: 1 }}>
                <div style={{ color: form.accent_color, fontWeight: 600, marginBottom: 20 }}>{r}</div>
                <div style={{ borderTop: "1px solid #9ca3af" }} />
              </div>
            ))}
          </div>
        )}
        {form.show_terms && form.terms_text && (
          <div style={{ marginTop: 16 }}>
            <div style={{ color: form.accent_color, fontWeight: 600, textTransform: "uppercase", fontSize: 10 }}>Terms & Conditions</div>
            <div style={{ whiteSpace: "pre-wrap", color: "#374151" }}>{form.terms_text}</div>
          </div>
        )}
      </div>
    </div>
  );
}
