import { describe, expect, it } from "vitest";

import {
  checkCap,
  cleanSecret,
  DEFAULT_CAP_MIN,
  readSettings,
  SECRETS,
  settingsOps,
} from "./settings";

describe("readSettings", () => {
  it("uses the defaults when nothing is stored", () => {
    expect(readSettings([])).toEqual({
      capMin: DEFAULT_CAP_MIN,
      dnd: true,
      theme: "dark",
      accent: "lime",
    });
  });

  it("reads stored values", () => {
    expect(
      readSettings([
        { key: "focus.daily_cap_min", value_json: "180" },
        { key: "focus.dnd", value_json: '"off"' },
        { key: "ui.theme", value_json: '"light"' },
        { key: "ui.accent", value_json: '"teal"' },
      ]),
    ).toEqual({ capMin: 180, dnd: false, theme: "light", accent: "teal" });
  });

  it("ignores broken values", () => {
    expect(
      readSettings([
        { key: "focus.daily_cap_min", value_json: "nope" },
        { key: "ui.theme", value_json: null },
      ]),
    ).toEqual({ capMin: DEFAULT_CAP_MIN, dnd: true, theme: "dark", accent: "lime" });
  });
});

describe("checkCap", () => {
  it("accepts whole minutes in range", () => {
    expect(checkCap(" 300 ")).toEqual({ minutes: 300 });
  });

  it.each(["", "10", "721", "2.5", "abc", "-60"])("rejects %j", (text) => {
    expect(checkCap(text)).toHaveProperty("error");
  });
});

describe("settingsOps", () => {
  it("writes JSON the Rust side reads", () => {
    const ops = settingsOps({ capMin: 200, dnd: false, theme: "light", accent: "sky" });
    expect(ops).toEqual([
      {
        op: "upsert",
        table: "core_settings",
        id: "focus.daily_cap_min",
        values: { value_json: "200" },
      },
      { op: "upsert", table: "core_settings", id: "focus.dnd", values: { value_json: '"off"' } },
      { op: "upsert", table: "core_settings", id: "ui.theme", values: { value_json: '"light"' } },
      { op: "upsert", table: "core_settings", id: "ui.accent", values: { value_json: '"sky"' } },
    ]);
  });
});

describe("secrets", () => {
  it("only names the secrets Rust allows", () => {
    expect(SECRETS.map((secret) => secret.name)).toEqual(["gemini_api_key", "ical_url"]);
  });

  it("trims pasted values", () => {
    expect(cleanSecret("  AIza-key \n")).toBe("AIza-key");
  });
});
