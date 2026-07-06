export function StatusFilter({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <select className="filter-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All statuses</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt.replace(/_/g, " ")}
        </option>
      ))}
    </select>
  );
}
