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

const THEME_COLOR = { light: "#ffffff", dark: "#0f1116" } as const;

/**
 * The static light/dark `<meta name="theme-color" media="...">` tags in
 * index.html only cover the OS preference at pre-paint. Once resolved (which
 * can be an explicit user override), this tag drives the actual browser/PWA
 * chrome color — kept as a single unconditional tag, separate from the
 * static ones, and updated in place rather than duplicated.
 */
function ensureThemeColorMeta(): HTMLMetaElement {
  let meta = document.getElementById("theme-color-meta") as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement("meta");
    meta.id = "theme-color-meta";
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  return meta;
}

function apply(pref: ThemePreference) {
  const resolved = resolve(pref);
  document.documentElement.dataset.theme = resolved;
  ensureThemeColorMeta().content = THEME_COLOR[resolved];
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
  // index.html's inline script already stamped data-theme before first paint,
  // but it doesn't (and can't, being static markup) create the runtime
  // theme-color meta tag — do that now so the PWA/browser chrome color is
  // correct from the first render, not just after a later theme change.
  apply(getThemePreference());

  const mq = window.matchMedia(DARK_QUERY);
  const onChange = () => {
    if (getThemePreference() === "system") apply("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
