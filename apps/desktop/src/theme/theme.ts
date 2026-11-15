/**
 * Theme choice (docs/design.md): Night by default, Forest on request. Applied
 * before first paint from a cached value, then confirmed from settings, so
 * the window never flashes the wrong theme. Older values ("dark", "light")
 * read as Night.
 */
export type Theme = "night" | "forest";

export const THEMES: { theme: Theme; label: string }[] = [
  { theme: "night", label: "Night" },
  { theme: "forest", label: "Forest" },
];

const CACHE_KEY = "sirna.theme";

const asTheme = (value: unknown): Theme => (value === "forest" ? "forest" : "night");

export function cachedTheme(): Theme {
  try {
    return asTheme(localStorage.getItem(CACHE_KEY));
  } catch {
    return "night";
  }
}

/** Sent on the window whenever the theme changes, so every switch shows it. */
export const THEME_EVENT = "sirna:theme";

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(THEME_EVENT));
  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // Storage can be unavailable; the setting in SQLite is the source of truth.
  }
}

/** Reads the `ui.theme` setting value (a JSON string) into a theme. */
export function themeFromSetting(valueJson: string | undefined): Theme {
  if (!valueJson) return "night";
  try {
    return asTheme(JSON.parse(valueJson));
  } catch {
    return "night";
  }
}

/** Settings that confirm the cached look at start (the cache can be empty or stale). */
export const LOOK_SQL = "SELECT key, value_json FROM core_settings WHERE key = 'ui.theme'";
