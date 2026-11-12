/** Settings page logic (plan §3.14, §9). Pure and tested; secrets never pass through here. */
import { type Op } from "../../kernel/db";
import { type Accent, accentFromSetting } from "../../theme/theme";

/** Secrets the main window may set or remove, never read (Rust SECRET_NAMES). */
export const SECRETS = [
  {
    name: "gemini_api_key",
    label: "Gemini API key",
    help: "From aistudio.google.com → Get API key. Used from M4 for the timing check and phrasing.",
    placeholder: "Paste the key",
  },
  {
    name: "ical_url",
    label: "Google Calendar secret address (iCal)",
    help: "Google Calendar → Settings → your calendar → Integrate calendar → Secret address in iCal format. Used from M6.",
    placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics",
  },
] as const;

export type SecretName = (typeof SECRETS)[number]["name"];

export const SETTINGS_SQL = `SELECT key, value_json FROM core_settings
  WHERE key IN ('focus.daily_cap_min', 'focus.dnd', 'ui.theme', 'ui.accent')`;

export const DEFAULT_CAP_MIN = 240;
export const MIN_CAP_MIN = 30;
export const MAX_CAP_MIN = 720;

export interface SettingsValues {
  capMin: number;
  dnd: boolean;
  theme: "dark" | "light";
  accent: Accent;
}

function parse(json: string | null | undefined): unknown {
  if (json == null) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads the stored rows into values, with the same defaults Rust uses. */
export function readSettings(rows: { key: string; value_json: string | null }[]): SettingsValues {
  const value = (key: string) => parse(rows.find((row) => row.key === key)?.value_json);
  const cap = value("focus.daily_cap_min");
  return {
    capMin: typeof cap === "number" && Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP_MIN,
    dnd: value("focus.dnd") !== "off",
    theme: value("ui.theme") === "light" ? "light" : "dark",
    accent: accentFromSetting(rows.find((row) => row.key === "ui.accent")?.value_json),
  };
}

/** A whole number of minutes in range, or an error to show. */
export function checkCap(text: string): { minutes: number } | { error: string } {
  const minutes = Number(text.trim());
  if (!/^\d+$/.test(text.trim()) || minutes < MIN_CAP_MIN || minutes > MAX_CAP_MIN) {
    return { error: `Use whole minutes from ${MIN_CAP_MIN} to ${MAX_CAP_MIN}.` };
  }
  return { minutes };
}

/** The writes for the plain (non-secret) settings. */
export function settingsOps(values: SettingsValues): Op[] {
  const setting = (key: string, value: unknown): Op => ({
    op: "upsert",
    table: "core_settings",
    id: key,
    values: { value_json: JSON.stringify(value) },
  });
  return [
    setting("focus.daily_cap_min", values.capMin),
    setting("focus.dnd", values.dnd ? "on" : "off"),
    setting("ui.theme", values.theme),
    setting("ui.accent", values.accent),
  ];
}

/** A pasted secret, trimmed; empty means nothing to save. */
export function cleanSecret(text: string): string {
  return text.trim();
}
