import { describe, expect, it } from "vitest";

import { readPending, touchesTasks } from "./App";

describe("readPending", () => {
  it("opens the review, or Notes with the capture box's query", () => {
    expect(readPending("review")).toEqual({ screen: "review", notesQuery: "" });
    expect(readPending("notes:git reset")).toEqual({ screen: "notes", notesQuery: "git reset" });
    expect(readPending("notes:")).toEqual({ screen: "notes", notesQuery: "" });
    expect(readPending("money")).toEqual({ screen: "money", notesQuery: "" });
  });

  it("ignores nothing or anything unknown", () => {
    expect(readPending(null)).toEqual({ notesQuery: "" });
    expect(readPending("something")).toEqual({ notesQuery: "" });
  });
});

describe("touchesTasks", () => {
  it("heals plans after a task change or a new day, not after a block write", () => {
    expect(touchesTasks(["task_items", "core_raw_items"])).toBe(true);
    expect(touchesTasks(["day"])).toBe(true);
    expect(touchesTasks(["day_blocks"])).toBe(false);
    expect(touchesTasks(undefined)).toBe(false);
  });
});
