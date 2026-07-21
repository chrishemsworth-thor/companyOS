import { CURRENCIES } from "../lib/currencies";

/**
 * Currency dropdown over the curated ISO 4217 list. A stored value outside the
 * list (the backend accepts any 3-letter code) is kept selectable so editing a
 * record never silently changes its currency.
 */
export function CurrencySelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (code: string) => void;
  id?: string;
}) {
  const known = CURRENCIES.some((c) => c.code === value);
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {!known && value && <option value={value}>{value}</option>}
      {CURRENCIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
