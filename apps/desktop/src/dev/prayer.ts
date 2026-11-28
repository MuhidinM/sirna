/**
 * commands::prayer_times for the browser preview: fixed times for Addis Ababa
 * (IslamicFinder, 28 Nov 2026, Muslim World League, Shafi'i), not the `salah`
 * maths. Adama is 2 minutes earlier; your offsets and Jumu'ah time apply.
 */
import { localDate } from "../kernel/dates";
import { parseHhmm, type PrayerSettings, type PrayerTimes } from "../features/prayer/prayer";

const ADDIS = { fajr: 310, sunrise: 383, dhuhr: 734, asr: 934, maghrib: 1084, isha: 1153 };

export function previewPrayerTimes(
  date: string | null,
  settings: PrayerSettings,
  nowMs: number,
): PrayerTimes {
  const day = date ?? localDate(nowMs);
  const shift = settings.city === "adama" ? -2 : 0;
  const hanafi = settings.asr === "hanafi" ? 50 : 0;
  const at = (name: keyof typeof ADDIS) => ADDIS[name] + shift + settings.offsets[name];
  const dhuhr = at("dhuhr");
  const friday = new Date(`${day}T12:00:00Z`).getUTCDay() === 5;
  return {
    date: day,
    city: settings.city,
    fajr: at("fajr") - (settings.method === "egyptian" ? 7 : 0),
    sunrise: at("sunrise"),
    dhuhr,
    asr: at("asr") + hanafi,
    maghrib: at("maghrib"),
    isha: at("isha"),
    jumuah: friday ? (parseHhmm(settings.jumuah) ?? dhuhr) : null,
  };
}
