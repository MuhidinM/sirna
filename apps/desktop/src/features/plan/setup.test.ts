import { describe, expect, it } from "vitest";

import { DEFAULT_ANSWERS } from "./routine";
import { SETUP_DONE_KEY, setupOps, type SetupChoices } from "./setup";

const choices: SetupChoices = {
  ...DEFAULT_ANSWERS,
  clockStyle: "western",
  targetsHours: { jobhunt: 5, coding: 3 },
};
const areas = ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"];
let n = 0;
const newId = () => `b${++n}`;

describe("setupOps", () => {
  it("saves the day settings and marks setup done last", () => {
    const ops = setupOps(choices, [], areas, newId);
    const keys = ops.filter((op) => op.table === "core_settings").map((op) => op.id);
    expect(keys).toEqual([
      "day.wake",
      "day.hard_stop",
      "day.review",
      "capture.clock_style",
      "setup.answers",
      SETUP_DONE_KEY,
    ]);
    expect(ops.at(-1)).toMatchObject({
      op: "upsert",
      id: SETUP_DONE_KEY,
      values: { value_json: "true" },
    });
  });

  it("turns weekly hours into minutes and switches areas on and off", () => {
    const ops = setupOps({ ...choices, activeAreas: ["joba", "coding"] }, [], areas, newId);
    expect(ops).toContainEqual({
      op: "update",
      table: "area_items",
      id: "coding",
      values: { active: 1, weekly_target_min: 180 },
    });
    expect(ops).toContainEqual({
      op: "update",
      table: "area_items",
      id: "gym",
      values: { active: 0 },
    });
  });

  it("names the job areas after the jobs", () => {
    const ops = setupOps(choices, [], areas, newId);
    expect(ops).toContainEqual({
      op: "update",
      table: "area_items",
      id: "joba",
      values: { name: "Job A" },
    });
  });

  it("replaces an existing routine", () => {
    const ops = setupOps(choices, ["old1", "old2"], areas, newId);
    expect(ops.filter((op) => op.op === "delete").map((op) => op.id)).toEqual(["old1", "old2"]);
    expect(
      ops.filter((op) => op.op === "insert" && op.table === "routine_blocks").length,
    ).toBeGreaterThan(20);
  });
});
