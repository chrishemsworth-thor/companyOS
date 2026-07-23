import { useState } from "react";
import { Monitor, Sun, Moon } from "lucide-react";
import { cn } from "../lib/cn";
import { getThemePreference, setThemePreference, type ThemePreference } from "../lib/theme";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/**
 * Compact icon-only light/dark/system switch for the sidebar footer. The
 * preference lives in localStorage (src/lib/theme.ts), so it applies before
 * login and across sessions; "system" defers to the OS appearance.
 */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>(getThemePreference);

  const select = (value: ThemePreference) => {
    setThemePreference(value);
    setPref(value);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="inline-flex shrink-0 gap-0.5 rounded-md bg-surface-2 p-0.5"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          role="radio"
          aria-checked={pref === value}
          aria-label={`${label} theme`}
          title={`${label} theme`}
          onClick={() => select(value)}
          className={cn(
            "grid cursor-pointer place-items-center rounded p-1.5 transition-colors",
            pref === value
              ? "bg-surface text-fg shadow-sm"
              : "text-subtle hover:text-fg",
          )}
        >
          <Icon className="size-4 shrink-0" />
        </button>
      ))}
    </div>
  );
}
