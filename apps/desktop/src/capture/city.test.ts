import { describe, expect, it } from "vitest";

import { readings } from "./alternatives";
import { echo, toOps } from "./ops";
import { parseCapture, readCity } from "./parse";

const nowMs = Date.parse("2026-11-28T10:00:00+03:00");

describe("I'm in Adama (T-092)", () => {
  it.each([
    ["I'm in Adama", "adama"],
    ["im in adama", "adama"],
    ["in addis", "addis"],
    ["I am in Addis Ababa.", "addis"],
    ["now in adama", "adama"],
  ])("%j sets the city", (line, city) => {
    expect(parseCapture(line, { nowMs })).toEqual({ kind: "city", city });
  });

  it("leaves other lines alone", () => {
    expect(readCity("in addis tomorrow")).toBeUndefined();
    expect(readCity("meeting in adama")).toBeUndefined();
    expect(parseCapture("meeting in adama", { nowMs }).kind).not.toBe("city");
  });

  it("writes only prayer.city and says so", () => {
    const parsed = parseCapture("I'm in Adama", { nowMs });
    expect(toOps(parsed, { nowMs, newId: () => "x" })).toEqual([
      {
        op: "upsert",
        table: "core_settings",
        id: "prayer.city",
        values: { value_json: '"adama"' },
      },
    ]);
    expect(echo(parsed, nowMs)).toBe("In Adama · prayer times from here");
    expect(readings(parsed, "I'm in Adama", nowMs)).toEqual([parsed]);
  });
});
