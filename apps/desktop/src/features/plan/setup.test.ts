import { describe, expect, it } from "vitest";

import { DEFAULT_ANSWERS } from "./routine";
import { newJob, SETUP_DONE_KEY, setupOps, type SetupChoices } from "./setup";

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

  it("adds a new job's area before the blocks that point at it", () => {
    const jobC = newJob(areas, ["Job A", "Job B"]);
    const ops = setupOps(
      {
        ...choices,
        jobs: [...choices.jobs, jobC],
        activeAreas: [...choices.activeAreas, jobC.areaId],
      },
      [],
      areas,
      newId,
      areas,
    );
    const insert = ops.findIndex((op) => op.op === "insert" && op.table === "area_items");
    expect(ops[insert]).toEqual({
      op: "insert",
      table: "area_items",
      id: "job-c",
      values: {
        name: "Job C",
        kind: "work",
        color: "work",
        weekly_target_min: 0,
        capped: 0,
        protected: 0,
        priority_rank: 2,
        active: 1,
      },
    });
    const firstBlock = ops.findIndex(
      (op) => op.op === "insert" && op.table === "routine_blocks" && op.values.area_id === "job-c",
    );
    expect(firstBlock).toBeGreaterThan(insert);
    // A saved job is only renamed, never inserted again.
    expect(ops.filter((op) => op.table === "area_items" && op.id === "joba")).toEqual([
      { op: "update", table: "area_items", id: "joba", values: { active: 1 } },
      { op: "update", table: "area_items", id: "joba", values: { name: "Job A" } },
    ]);
  });

  it("switches a removed job off and plans no blocks for it", () => {
    const jobs = choices.jobs.filter((job) => job.areaId !== "jobb");
    const ops = setupOps(
      { ...choices, jobs, activeAreas: choices.activeAreas.filter((id) => id !== "jobb") },
      [],
      areas,
      newId,
      areas,
    );
    expect(ops).toContainEqual({
      op: "update",
      table: "area_items",
      id: "jobb",
      values: { active: 0 },
    });
    expect(ops.some((op) => op.op === "delete" && op.table === "area_items")).toBe(false);
    expect(
      ops.some(
        (op) => op.op === "insert" && op.table === "routine_blocks" && op.values.area_id === "jobb",
      ),
    ).toBe(false);
  });
});

describe("newJob", () => {
  it("takes the next free letter and a fresh id", () => {
    expect(newJob(areas, ["Job A", "Job B"])).toEqual({
      areaId: "job-c",
      name: "Job C",
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "17:00",
    });
    expect(newJob([...areas, "job-c"], ["job a", "Job B"]).areaId).toBe("job-c-2");
    // A renamed job frees its letter.
    expect(newJob(areas, ["Kifiya", "Job B"]).name).toBe("Job A");
  });
});
