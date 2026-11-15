import { describe, expect, it } from "vitest";

import { type AreaInput, type PlanInput, type TaskInput } from "./generate";
import { shiftDate } from "./dayplan";
import { planTodayOps, previewWeek, pushDeadlineOps } from "./preview";

const coding: AreaInput = {
  id: "coding",
  name: "Coding",
  weeklyTargetMin: 6000,
  capped: false,
  protected: false,
  priorityRank: 1,
  active: true,
  kind: "growth",
};
// 2026-11-16 is a Monday.
const MON = "2026-11-16";
const day = (offset: number, tasks: TaskInput[]): PlanInput => ({
  date: shiftDate(MON, offset),
  isRestDay: false,
  recentEnergy: [3, 3],
  // One 2-hour free slot a day: 96 minutes are planned (20% kept open).
  template: [
    { startMin: 18 * 60, durationMin: 120, kind: "area", areaId: null, title: "Focus block" },
  ],
  kept: [],
  areas: [coding],
  doneThisWeekMin: {},
  tasks,
  chosenTop: [],
});
const task = (over: Partial<TaskInput>): TaskInput => ({
  id: "t",
  title: "Portfolio",
  areaId: "coding",
  dueDate: null,
  createdAt: 0,
  remainingMin: null,
  ...over,
});

describe("the week ahead (T-069)", () => {
  it("spreads a big task over the days it needs, and flags it when the deadline comes first", () => {
    const big = task({ remainingMin: 300, dueDate: shiftDate(MON, 2) });
    const preview = previewWeek([0, 1, 2, 3, 4, 5, 6].map((i) => day(i, [big])));
    // 96 + 96 + 96 = 288 by Wednesday; 12 minutes still missing then.
    expect(
      preview.days.slice(0, 4).map((d) => d.blocks.map((b) => [b.taskId, b.durationMin])),
    ).toEqual([[["t", 96]], [["t", 96]], [["t", 96]], [["t", 96]]]);
    expect(preview.late).toEqual([
      { id: "t", title: "Portfolio", dueDate: "2026-11-18", shortMin: 12, finishes: "2026-11-19" },
    ]);
  });

  it("is quiet when the list fits, and doesn't judge deadlines past the week", () => {
    const small = task({ id: "s", remainingMin: 90, dueDate: shiftDate(MON, 1) });
    const far = task({ id: "f", title: "Far", remainingMin: 5000, dueDate: shiftDate(MON, 30) });
    const preview = previewWeek([0, 1, 2, 3, 4, 5, 6].map((i) => day(i, [small, far])));
    expect(preview.late).toEqual([]);
    // Without an estimate a task is done after one block.
    const quick = previewWeek([day(0, [task({ id: "q" })]), day(1, [task({ id: "q" })])]);
    expect(quick.days.map((d) => d.blocks[0]?.taskId ?? null)).toEqual(["q", null]);
  });

  it("flags a task due this week that never gets time", () => {
    const busy = { ...day(0, []), template: [] };
    const due = task({ id: "d", title: "Report", dueDate: MON, remainingMin: 60 });
    const preview = previewWeek([{ ...busy, tasks: [due] }]);
    expect(preview.late).toEqual([
      { id: "d", title: "Report", dueDate: MON, shortMin: 60, finishes: null },
    ]);
  });

  it("moves a task earlier or pushes its deadline a week", () => {
    expect(planTodayOps("t", MON)).toEqual([
      { op: "update", table: "task_items", id: "t", values: { planned_date: MON } },
    ]);
    expect(pushDeadlineOps({ id: "t", dueDate: "2026-11-18" })[0]).toMatchObject({
      values: { due_date: "2026-11-25", deadline_stale: 0 },
    });
  });
});
