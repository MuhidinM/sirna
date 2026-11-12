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

// --- Accent colour (plan §3.14, from Mamuku) ------------------------------------

export type Accent = "lime" | "sky" | "coral" | "violet" | "rose" | "teal";

export const ACCENTS: { accent: Accent; label: string }[] = [
  { accent: "lime", label: "Lime" },
  { accent: "sky", label: "Sky" },
  { accent: "coral", label: "Coral" },
  { accent: "violet", label: "Violet" },
  { accent: "rose", label: "Rose" },
  { accent: "teal", label: "Teal" },
];

const ACCENT_KEY = "sirna.accent";

export function accentFromSetting(valueJson: string | undefined | null): Accent {
  try {
    const value = JSON.parse(valueJson ?? "null") as unknown;
    return ACCENTS.some((a) => a.accent === value) ? (value as Accent) : "lime";
  } catch {
    return "lime";
  }
}

export function cachedAccent(): Accent {
  try {
    return accentFromSetting(JSON.stringify(localStorage.getItem(ACCENT_KEY)));
  } catch {
    return "lime";
  }
}

export function applyAccent(accent: Accent, root: HTMLElement = document.documentElement): void {
  root.dataset.accent = accent;
  try {
    localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    // The setting in SQLite stays the source of truth.
  }
}

/** Settings that confirm the cached look at start (the cache can be empty or stale). */
export const LOOK_SQL =
  "SELECT key, value_json FROM core_settings WHERE key IN ('ui.theme', 'ui.accent')";
