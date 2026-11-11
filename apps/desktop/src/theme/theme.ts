/**
 * Theme choice: dark by default (plan §3.14), light on request. Applied
 * before first paint from a cached value, then confirmed from settings, so
 * the window never flashes the wrong theme.
 */
export type Theme = "dark" | "light";

const CACHE_KEY = "sirna.theme";

export function cachedTheme(): Theme {
  try {
    return localStorage.getItem(CACHE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // Storage can be unavailable; the setting in SQLite is the source of truth.
  }
}

/** Reads the `ui.theme` setting value (a JSON string) into a theme. */
export function themeFromSetting(valueJson: string | undefined): Theme {
  if (!valueJson) return "dark";
  try {
    return JSON.parse(valueJson) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
