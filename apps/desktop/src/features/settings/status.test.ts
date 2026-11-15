import { describe, expect, it } from "vitest";

import { statusLines } from "./status";

const TODAY = "2026-11-15";
const sync = (code: string, held = false) => JSON.stringify({ at: 0, code, count: 12, held });
const ai = { has_key: true, model: "gemini-flash", used: 3, cap: 20 };
const view = (input: Parameters<typeof statusLines>[0]) =>
  statusLines(input).map((line) => [line.name, line.ok]);

describe("the Settings status strip (T-075)", () => {
  it("shows all fine", () => {
    const lines = statusLines({
      syncJson: sync("ok"),
      ai,
      backupJson: '"2026-11-15"',
      today: TODAY,
    });
    expect(lines.map((line) => [line.name, line.ok])).toEqual([
      ["Calendar", true],
      ["AI", true],
      ["Backups", true],
    ]);
    expect(lines[1]?.text).toBe("gemini-flash · 3 of 20 requests used today.");
  });

  it("says what isn't set up yet, without calling it a problem", () => {
    expect(view({ syncJson: null, ai: null, backupJson: null, today: TODAY })).toEqual([
      ["Calendar", null],
      ["AI", null],
      ["Backups", null],
    ]);
    expect(
      view({
        syncJson: sync("no-link"),
        ai: { ...ai, has_key: false },
        backupJson: null,
        today: TODAY,
      })[0],
    ).toEqual(["Calendar", null]);
  });

  it("says what needs you, and how to fix it", () => {
    const lines = statusLines({
      syncJson: sync("link_revoked"),
      ai: { ...ai, model: null },
      backupJson: '"2026-11-10"',
      today: TODAY,
    });
    expect(lines.map((line) => line.ok)).toEqual([false, false, false]);
    expect(lines[0]?.text).toMatch(/Secret address in iCal format/);
    expect(lines[1]?.text).toMatch(/choose one under AI/);
    expect(lines[2]?.text).toBe(
      "Last backup 2026-11-10: check the backup folder still exists and has space.",
    );
    expect(
      statusLines({
        syncJson: sync("ok", true),
        ai: { ...ai, used: 20 },
        backupJson: '"2026-11-13"',
        today: TODAY,
      }).map((l) => l.ok),
    ).toEqual([false, false, true]);
  });
});
