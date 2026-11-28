import { describe, expect, it } from "vitest";

import {
  checkPrayerSettings,
  hhmm,
  parseHhmm,
  prayerLine,
  prayerSettingsOps,
  type PrayerTimes,
  ramadanDay,
  ramadanLine,
  readPrayerSettings,
} from "./prayer";

const SATURDAY: PrayerTimes = {
  date: "2026-11-28",
  city: "addis",
  fajr: 5 * 60 + 10,
  sunrise: 6 * 60 + 23,
  dhuhr: 12 * 60 + 14,
  asr: 15 * 60 + 34,
  maghrib: 18 * 60 + 4,
  isha: 19 * 60 + 13,
  jumuah: null,
};

describe("readPrayerSettings", () => {
  it("uses the defaults Rust uses", () => {
    const values = readPrayerSettings([]);
    expect(values).toMatchObject({
      city: "addis",
      method: "mwl",
      asr: "shafii",
      jumuah: "",
      notifyAfterMin: 5,
      enabled: true,
      fajrToast: true,
      ramadanStart: "",
    });
    expect(values.offsets.fajr).toBe(0);
  });

  it("reads stored values and drops bad ones", () => {
    const values = readPrayerSettings([
      { key: "prayer.city", value_json: '"adama"' },
      { key: "prayer.method", value_json: '"egyptian"' },
      { key: "prayer.asr", value_json: '"hanafi"' },
      { key: "prayer.offsets", value_json: '{"fajr": 2, "isha": "x"}' },
      { key: "prayer.jumuah", value_json: '"12:30"' },
      { key: "prayer.notify_after_min", value_json: "10" },
      { key: "prayer.fajr_toast", value_json: "false" },
      { key: "ramadan.start", value_json: '"2027-02-08"' },
    ]);
    expect(values).toMatchObject({
      city: "adama",
      method: "egyptian",
      asr: "hanafi",
      jumuah: "12:30",
      notifyAfterMin: 10,
      fajrToast: false,
      ramadanStart: "2027-02-08",
    });
    expect(values.offsets).toMatchObject({ fajr: 2, isha: 0 });
    expect(readPrayerSettings([{ key: "prayer.jumuah", value_json: '"noon"' }]).jumuah).toBe("");
  });
});

describe("checkPrayerSettings and prayerSettingsOps", () => {
  it("refuses bad input, one problem at a time", () => {
    const base = readPrayerSettings([]);
    expect(checkPrayerSettings(base)).toBeNull();
    expect(checkPrayerSettings({ ...base, city: "custom", lat: "", lng: "38" })).toMatch(
      /Latitude/,
    );
    expect(checkPrayerSettings({ ...base, offsets: { ...base.offsets, asr: 90 } })).toMatch(
      /offset/,
    );
    expect(checkPrayerSettings({ ...base, jumuah: "1pm" })).toMatch(/Jumu'ah/);
    expect(checkPrayerSettings({ ...base, ramadanStart: "feb 8" })).toMatch(/Ramadan/);
  });

  it("writes every setting, and lat/lng only for a custom place", () => {
    const base = readPrayerSettings([]);
    const keys = (ops: ReturnType<typeof prayerSettingsOps>) =>
      ops.map((op) => (op.op === "upsert" ? op.id : ""));
    expect(keys(prayerSettingsOps(base))).not.toContain("prayer.lat");
    const custom = prayerSettingsOps({ ...base, city: "custom", lat: "9.1", lng: "38.7" });
    expect(custom).toContainEqual({
      op: "upsert",
      table: "core_settings",
      id: "prayer.lat",
      values: { value_json: "9.1" },
    });
  });

  it("writes only what changed, so a Save keeps a city set from the tray", () => {
    const stored = { ...readPrayerSettings([]), city: "adama" as const };
    // The form still shows Addis from when Settings opened; the user changed Jumu'ah.
    const form = { ...stored, city: "addis" as const, jumuah: "12:45" };
    const ops = prayerSettingsOps({ ...form, city: stored.city }, stored);
    expect(ops).toEqual([
      {
        op: "upsert",
        table: "core_settings",
        id: "prayer.jumuah",
        values: { value_json: '"12:45"' },
      },
    ]);
    expect(prayerSettingsOps(stored, stored)).toEqual([]);
    expect(prayerSettingsOps(form, stored).map((op) => (op.op === "upsert" ? op.id : ""))).toEqual([
      "prayer.city",
      "prayer.jumuah",
    ]);
  });
});

describe("lines on Today", () => {
  it("shows the five times, Jumu'ah on Friday", () => {
    expect(prayerLine(SATURDAY)).toBe(
      "Fajr 05:10 · Dhuhr 12:14 · Asr 15:34 · Maghrib 18:04 · Isha 19:13",
    );
    expect(prayerLine({ ...SATURDAY, jumuah: 12 * 60 + 30 })).toContain("Jumu'ah 12:30 · Asr");
  });

  it("counts Ramadan days for 30 days from the start", () => {
    expect(ramadanDay("2026-11-26", "2026-11-28")).toBe(3);
    expect(ramadanDay("2026-11-28", "2026-11-27")).toBeNull();
    expect(ramadanDay("2026-10-30", "2026-11-28")).toBe(30);
    expect(ramadanDay("2026-10-29", "2026-11-28")).toBeNull();
    expect(ramadanDay("", "2026-11-28")).toBeNull();
    expect(ramadanLine("2026-11-26", "2026-11-28", SATURDAY)).toBe(
      "Ramadan day 3 · Suhoor ends 05:10 · Iftar 18:04",
    );
  });

  it("formats and reads HH:MM", () => {
    expect(hhmm(390)).toBe("06:30");
    expect(parseHhmm("6:30")).toBe(390);
    expect(parseHhmm("24:00")).toBeUndefined();
  });
});
