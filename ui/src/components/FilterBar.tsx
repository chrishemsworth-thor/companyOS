import { ChevronDown } from "lucide-react";

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
    <div className="relative inline-flex">
      <select
        className="h-10 cursor-pointer appearance-none rounded-md border border-border bg-surface pl-3 pr-9 text-sm text-fg capitalize transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All statuses</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle"
        aria-hidden
      />
    </div>
  );
}
