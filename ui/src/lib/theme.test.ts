import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getThemePreference, setThemePreference, watchSystemTheme } from "./theme";

type Listener = () => void;

/** Minimal matchMedia stub whose `matches` we can flip and whose change
 * listeners we can fire, standing in for an OS appearance switch. */
function stubMatchMedia(initiallyDark: boolean) {
  const listeners = new Set<Listener>();
  const mq = {
    matches: initiallyDark,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => mq);
  return {
    setDark(dark: boolean) {
      mq.matches = dark;
      listeners.forEach((fn) => fn());
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme preference", () => {
  it("defaults to system and resolves it from the OS appearance", () => {
    stubMatchMedia(true);
    expect(getThemePreference()).toBe("system");
    setThemePreference("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("an explicit choice persists and overrides the OS appearance", () => {
    stubMatchMedia(true);
    setThemePreference("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(getThemePreference()).toBe("light");
  });

  it("switching back to system clears the override", () => {
    stubMatchMedia(false);
    setThemePreference("dark");
    setThemePreference("system");
    expect(getThemePreference()).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("tracks OS changes only while the preference is system", () => {
    const os = stubMatchMedia(false);
    const stop = watchSystemTheme();

    setThemePreference("system");
    os.setDark(true);
    expect(document.documentElement.dataset.theme).toBe("dark");

    setThemePreference("light");
    os.setDark(false);
    os.setDark(true);
    expect(document.documentElement.dataset.theme).toBe("light");

    stop();
    expect(os.listenerCount()).toBe(0);
  });
});
