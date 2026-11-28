/**
 * Prayer times on Today and in Settings (T-092). The times themselves come
 * from Rust (`prayer_times`, the `salah` crate); this file reads the settings,
 * writes them back, and words the lines Today shows. Pure and tested.
 */
import { type Op } from "../../kernel/db";

/** commands::prayer_times: local minutes from midnight, Addis Ababa. */
export interface PrayerTimes {
  date: string;
  city: string;
  fajr: number;
  sunrise: number;
  dhuhr: number;
  asr: number;
  maghrib: number;
  isha: number;
  /** Fridays only. */
  jumuah: number | null;
}

export const PRAYER_KEYS = [
  "prayer.city",
  "prayer.lat",
  "prayer.lng",
  "prayer.method",
  "prayer.asr",
  "prayer.offsets",
  "prayer.jumuah",
  "prayer.notify_after_min",
  "prayer.enabled",
  "prayer.fajr_toast",
  "ramadan.start",
] as const;

export const PRAYER_SETTINGS_SQL = `SELECT key, value_json FROM core_settings
  WHERE key IN (${PRAYER_KEYS.map((key) => `'${key}'`).join(", ")})`;

export const OFFSET_NAMES = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"] as const;
export type OffsetName = (typeof OFFSET_NAMES)[number];

export type CityChoice = "addis" | "adama" | "custom";

export interface PrayerSettings {
  city: CityChoice;
  lat: string;
  lng: string;
  method: "mwl" | "egyptian";
  asr: "shafii" | "hanafi";
  offsets: Record<OffsetName, number>;
  /** HH:MM, or "" for Dhuhr. */
  jumuah: string;
  notifyAfterMin: number;
  enabled: boolean;
  fajrToast: boolean;
  /** YYYY-MM-DD, or "" when not set. */
  ramadanStart: string;
}

export const DEFAULT_NOTIFY_AFTER_MIN = 5;
export const RAMADAN_DAYS = 30;

function parse(json: string | null | undefined): unknown {
  if (json == null) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

const noOffsets = (): Record<OffsetName, number> => ({
  fajr: 0,
  sunrise: 0,
  dhuhr: 0,
  asr: 0,
  maghrib: 0,
  isha: 0,
});

/** The stored rows as values, with the defaults Rust uses (prayer.rs `config`). */
export function readPrayerSettings(
  rows: readonly { key: string; value_json: string | null }[],
): PrayerSettings {
  const value = (key: string) => parse(rows.find((row) => row.key === key)?.value_json);
  const text = (key: string) => {
    const v = value(key);
    return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  };
  const city = text("prayer.city").toLowerCase();
  const offsets = noOffsets();
  const stored = value("prayer.offsets");
  if (stored && typeof stored === "object") {
    for (const name of OFFSET_NAMES) {
      const minutes = (stored as Record<string, unknown>)[name];
      if (typeof minutes === "number" && Number.isInteger(minutes)) offsets[name] = minutes;
    }
  }
  const notify = value("prayer.notify_after_min");
  return {
    city: city === "adama" || city === "custom" ? city : "addis",
    lat: text("prayer.lat"),
    lng: text("prayer.lng"),
    method: text("prayer.method").toLowerCase() === "egyptian" ? "egyptian" : "mwl",
    asr: text("prayer.asr").toLowerCase() === "hanafi" ? "hanafi" : "shafii",
    offsets,
    jumuah: parseHhmm(text("prayer.jumuah")) === undefined ? "" : text("prayer.jumuah"),
    notifyAfterMin:
      typeof notify === "number" && Number.isInteger(notify) && notify >= 0
        ? notify
        : DEFAULT_NOTIFY_AFTER_MIN,
    enabled: value("prayer.enabled") !== false,
    fajrToast: value("prayer.fajr_toast") !== false,
    ramadanStart: isDate(text("ramadan.start")) ? text("ramadan.start") : "",
  };
}

/** "06:30" → 390; anything else → undefined. */
export function parseHhmm(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

function isDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
}

/** 390 → "06:30". */
export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Checks the form before saving: the first problem, or null. */
export function checkPrayerSettings(values: PrayerSettings): string | null {
  if (values.city === "custom") {
    const lat = Number(values.lat);
    const lng = Number(values.lng);
    if (values.lat.trim() === "" || !Number.isFinite(lat) || lat < -90 || lat > 90)
      return "Latitude is a number from -90 to 90.";
    if (values.lng.trim() === "" || !Number.isFinite(lng) || lng < -180 || lng > 180)
      return "Longitude is a number from -180 to 180.";
  }
  for (const name of OFFSET_NAMES) {
    const minutes = values.offsets[name];
    if (!Number.isInteger(minutes) || minutes < -60 || minutes > 60)
      return "Each offset is whole minutes from -60 to 60.";
  }
  if (values.jumuah !== "" && parseHhmm(values.jumuah) === undefined)
    return "Jumu'ah time is like 12:30, or empty for Dhuhr.";
  if (
    !Number.isInteger(values.notifyAfterMin) ||
    values.notifyAfterMin < 0 ||
    values.notifyAfterMin > 60
  )
    return "Toast after is whole minutes from 0 to 60.";
  if (values.ramadanStart !== "" && !isDate(values.ramadanStart))
    return "Ramadan start is a date like 2027-02-08, or empty.";
  return null;
}

/**
 * The writes for the Prayer section. With `stored`, only the settings that
 * differ from it: the tray or `I'm in Adama` can change the city while
 * Settings is open, and a Save of the Jumu'ah time mustn't put the old city
 * back (or block undoing that capture).
 */
export function prayerSettingsOps(values: PrayerSettings, stored?: PrayerSettings): Op[] {
  const ops = allPrayerOps(values);
  if (!stored) return ops;
  const before = new Map(allPrayerOps(stored).map((op) => [op.op === "upsert" ? op.id : "", op]));
  return ops.filter((op) => {
    if (op.op !== "upsert") return true;
    const old = before.get(op.id);
    return !(old?.op === "upsert" && old.values.value_json === op.values.value_json);
  });
}

function allPrayerOps(values: PrayerSettings): Op[] {
  const setting = (key: string, value: unknown): Op => ({
    op: "upsert",
    table: "core_settings",
    id: key,
    values: { value_json: JSON.stringify(value) },
  });
  const ops = [
    setting("prayer.city", values.city),
    setting("prayer.method", values.method),
    setting("prayer.asr", values.asr),
    setting("prayer.offsets", values.offsets),
    setting("prayer.jumuah", values.jumuah.trim()),
    setting("prayer.notify_after_min", values.notifyAfterMin),
    setting("prayer.enabled", values.enabled),
    setting("prayer.fajr_toast", values.fajrToast),
    setting("ramadan.start", values.ramadanStart.trim()),
  ];
  if (values.city === "custom")
    ops.push(setting("prayer.lat", Number(values.lat)), setting("prayer.lng", Number(values.lng)));
  return ops;
}

/** Today's compact line: `Fajr 05:10 · Dhuhr 12:14 · Asr 15:34 · Maghrib 18:04 · Isha 19:13`. */
export function prayerLine(times: PrayerTimes): string {
  const noon: [string, number] =
    times.jumuah === null ? ["Dhuhr", times.dhuhr] : ["Jumu'ah", times.jumuah];
  const parts: [string, number][] = [
    ["Fajr", times.fajr],
    noon,
    ["Asr", times.asr],
    ["Maghrib", times.maghrib],
    ["Isha", times.isha],
  ];
  return parts.map(([name, at]) => `${name} ${hhmm(at)}`).join(" · ");
}

/** Day N of Ramadan (1-based), or null outside the 30 days from its start. */
export function ramadanDay(start: string, today: string): number | null {
  if (!isDate(start) || !isDate(today)) return null;
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  );
  return days >= 0 && days < RAMADAN_DAYS ? days + 1 : null;
}

/** `Ramadan day 3 · Suhoor ends 05:10 · Iftar 18:04`, or null outside Ramadan. */
export function ramadanLine(start: string, today: string, times: PrayerTimes): string | null {
  const day = ramadanDay(start, today);
  if (day === null) return null;
  return `Ramadan day ${day} · Suhoor ends ${hhmm(times.fajr)} · Iftar ${hhmm(times.maghrib)}`;
}
