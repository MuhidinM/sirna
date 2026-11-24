import { describe, expect, it } from "vitest";

import { type BlockRow } from "../features/plan/now";
import { cardLabel, laneBox, taskLine } from "./board";

const MIN = 60_000;
const block = (over: Partial<BlockRow> = {}): BlockRow => ({
  id: "b1",
  start_at: 0,
  end_at: 57 * MIN,
  kind: "area",
  area_id: "a1",
  task_id: "t1",
  title: "Job hunt: Apply: Backend dev at Kifiya",
  status: "planned",
  color: "pink",
  task_title: "Apply: Backend dev at Kifiya",
  focused_min: 0,
  ...over,
});

describe("day board card label (F22)", () => {
  it("does not repeat a task the title already names", () => {
    expect(taskLine(block())).toBeNull();
    expect(taskLine(block({ title: "Job hunt" }))).toBe("Apply: Backend dev at Kifiya");
    expect(taskLine(block({ kind: "fixed", title: "Job A" }))).toBeNull();
  });

  it("puts focus progress right after the time, before the task name", () => {
    const label = cardLabel(block({ title: "Job hunt", focused_min: 25 }), "17.15 – 18.12", true);
    expect(label).toBe("17.15 – 18.12 · 25/57 min · Apply: Backend dev at Kifiya");
  });

  it("shows done and fixed as status, not after the task", () => {
    expect(cardLabel(block({ focused_min: 50 }), "17.15 – 18.12", true)).toBe(
      "17.15 – 18.12 · done",
    );
    expect(cardLabel(block({ kind: "fixed", title: "Job A" }), "08.00 – 12.00", false)).toBe(
      "08.00 – 12.00 · fixed",
    );
  });

  it("leaves minutes off a tall card, which has the bar", () => {
    expect(cardLabel(block({ focused_min: 25 }), "17.15 – 18.12", false)).toBe("17.15 – 18.12");
  });
});

describe("overlapping lanes (F103)", () => {
  it("keeps the first lane at least half wide", () => {
    expect(laneBox({ lane: 0, of: 1 })).toEqual({ left: "0%", width: "100%" });
    expect(laneBox({ lane: 0, of: 3 })).toEqual({ left: "0%", width: "calc(50% - 4px)" });
    expect(laneBox({ lane: 1, of: 3 })).toEqual({
      left: "calc(50% + 4px)",
      width: "calc(25% - 4px)",
    });
    expect(laneBox({ lane: 2, of: 3 })).toEqual({
      left: "calc(75% + 4px)",
      width: "calc(25% - 4px)",
    });
    expect(laneBox({ lane: 1, of: 2 })).toEqual({
      left: "calc(50% + 4px)",
      width: "calc(50% - 4px)",
    });
  });
});
