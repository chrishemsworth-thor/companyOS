import type { ReactNode } from "react";

/** Labeled form control, visually matching the read-only Field. */
export function FormRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="form-row">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
