/**
 * Theme preference: "system" follows the OS via prefers-color-scheme;
 * "light"/"dark" are explicit user overrides. The *resolved* theme is always
 * stamped on <html data-theme="…"> — styles.css keys every token flip off
 * that attribute, never off the media query directly, so CSS has a single
 * source of truth. An inline script in index.html stamps the attribute
 * before first paint (same storage key, same resolution rules) to avoid a
 * light-mode flash; keep the two in sync if either changes.
 */

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_THEME = "companyos_theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_THEME);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  }
  return pref;
}

function apply(pref: ThemePreference) {
  document.documentElement.dataset.theme = resolve(pref);
}

export function setThemePreference(pref: ThemePreference) {
  if (pref === "system") {
    localStorage.removeItem(STORAGE_THEME);
  } else {
    localStorage.setItem(STORAGE_THEME, pref);
  }
  apply(pref);
}

/**
 * Re-apply on OS theme changes while the preference is "system". Call once at
 * startup; returns an unsubscribe (unused in the app, handy in tests).
 */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia(DARK_QUERY);
  const onChange = () => {
    if (getThemePreference() === "system") apply("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
