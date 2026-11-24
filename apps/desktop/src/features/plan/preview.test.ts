import { describe, expect, it } from "vitest";

import { type AreaInput, type PlanInput, type TaskInput } from "./generate";
import { shiftDate } from "./dayplan";
import { fromNow, planTodayOps, previewWeek, pushDeadlineOps } from "./preview";

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
    // 90 + 90 + 90 = 270 by Wednesday; 30 minutes still missing then.
    expect(
      preview.days.slice(0, 4).map((d) => d.blocks.map((b) => [b.taskId, b.durationMin])),
    ).toEqual([[["t", 90]], [["t", 90]], [["t", 90]], [["t", 90]]]);
    expect(preview.late).toEqual([
      { id: "t", title: "Portfolio", dueDate: "2026-11-18", shortMin: 30, finishes: "2026-11-19" },
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

  it("leaves away days empty and gives them no time for tasks (F48)", () => {
    const big = task({ remainingMin: 150, dueDate: shiftDate(MON, 2) });
    const away = new Set([MON, shiftDate(MON, 1), shiftDate(MON, 2)]);
    const preview = previewWeek(
      [0, 1, 2, 3, 4].map((i) => day(i, [big])),
      away,
    );
    expect(preview.days.map((d) => [d.away ?? false, d.blocks.length])).toEqual([
      [true, 0],
      [true, 0],
      [true, 0],
      [false, 1],
      [false, 1],
    ]);
    // Due while away: late, and done on the days you are back.
    expect(preview.late).toEqual([
      { id: "t", title: "Portfolio", dueDate: "2026-11-18", shortMin: 150, finishes: "2026-11-20" },
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

  it("judges only tasks the planner places, not a job's or the gym's", () => {
    const job = task({ id: "j", title: "Report", areaId: "joba", dueDate: MON, remainingMin: 60 });
    const loose = task({ id: "l", title: "Loose", areaId: null, dueDate: MON, remainingMin: 600 });
    const input = {
      ...day(0, [job, loose]),
      areas: [coding, { ...coding, id: "joba", kind: "work" as const }],
    };
    expect(previewWeek([input]).late.map((t) => t.id)).toEqual(["l"]);
  });

  it("plans today only from now on", () => {
    const today = fromNow(day(0, []), 18 * 60 + 30);
    expect(today.template).toEqual([
      { startMin: 18 * 60 + 30, durationMin: 90, kind: "area", areaId: null, title: "Focus block" },
    ]);
    expect(fromNow(day(0, []), 21 * 60).template).toEqual([]);
  });

  it("shows a timed task's own block and doesn't judge a list-only task (time first)", () => {
    const call = task({
      id: "c",
      title: "Call bank",
      areaId: null,
      atMin: 10 * 60,
      estimateMin: 45,
    });
    const milk = task({ id: "m", title: "Buy milk", areaId: null, dueDate: MON });
    const preview = previewWeek([day(0, [call, milk])]);
    expect(preview.days[0]?.blocks).toContainEqual({
      startMin: 600,
      durationMin: 45,
      areaId: null,
      title: "Call bank",
      taskId: "c",
    });
    expect(preview.days[0]?.blocks.some((b) => b.taskId === "m")).toBe(false);
    expect(preview.late).toEqual([]);
  });

  it("forgets a time already gone today and starts parts of the day from now", () => {
    const gone = task({ id: "g", atMin: 9 * 60 });
    const soon = task({ id: "s", atMin: 20 * 60 });
    const today = fromNow(day(0, [gone, soon]), 12 * 60);
    expect(today.tasks.map((t) => t.atMin)).toEqual([null, 20 * 60]);
    expect(today.notBeforeMin).toBe(12 * 60);
  });
});

describe("a task block you moved or added", () => {
  it("covers its task that day, so it isn't late", () => {
    const due = task({ id: "d", remainingMin: 60, dueDate: MON });
    const moved = {
      ...day(0, [due]),
      kept: [{ startMin: 8 * 60, durationMin: 60, taskId: "d", title: "Portfolio" }],
    };
    const preview = previewWeek([moved, ...[1, 2, 3, 4, 5, 6].map((i) => day(i, [due]))]);
    expect(preview.late).toEqual([]);
    // It isn't planned a second time either.
    expect(preview.days[1]?.blocks.some((b) => b.taskId === "d")).toBe(false);
  });
});
