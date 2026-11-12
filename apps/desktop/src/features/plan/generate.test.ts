import { describe, expect, it } from "vitest";

import { type AreaInput, cut, generateDay, type PlanInput, type TaskInput } from "./generate";
import { DEFAULT_ANSWERS, defaultRoutine, type Weekday } from "./routine";

const AREAS: AreaInput[] = [
  {
    id: "joba",
    name: "Job A",
    weeklyTargetMin: 0,
    capped: false,
    protected: false,
    priorityRank: 2,
    active: true,
    kind: "work",
  },
  {
    id: "jobb",
    name: "Job B",
    weeklyTargetMin: 0,
    capped: false,
    protected: false,
    priorityRank: 2,
    active: true,
    kind: "work",
  },
  {
    id: "jobhunt",
    name: "Job hunt",
    weeklyTargetMin: 240,
    capped: false,
    protected: false,
    priorityRank: 3,
    active: true,
    kind: "growth",
  },
  {
    id: "coding",
    name: "Coding skills",
    weeklyTargetMin: 240,
    capped: false,
    protected: false,
    priorityRank: 5,
    active: true,
    kind: "growth",
  },
  {
    id: "experiments",
    name: "Experiments",
    weeklyTargetMin: 180,
    capped: true,
    protected: false,
    priorityRank: 6,
    active: true,
    kind: "growth",
  },
  {
    id: "gym",
    name: "Gym",
    weeklyTargetMin: 135,
    capped: false,
    protected: true,
    priorityRank: 4,
    active: true,
    kind: "health",
  },
  {
    id: "quran",
    name: "Quran",
    weeklyTargetMin: 140,
    capped: false,
    protected: true,
    priorityRank: 4,
    active: true,
    kind: "faith",
  },
  {
    id: "admin",
    name: "Life admin",
    weeklyTargetMin: 140,
    capped: false,
    protected: false,
    priorityRank: 7,
    active: true,
    kind: "admin",
  },
];

const week = defaultRoutine(DEFAULT_ANSWERS);
const templateFor = (weekday: Weekday) =>
  week.filter((block) => block.weekday === weekday).map(({ weekday: _w, ...block }) => block);

const task = (
  id: string,
  areaId: string | null,
  dueDate: string | null = null,
  createdAt = 0,
): TaskInput => ({
  id,
  title: id,
  areaId,
  dueDate,
  createdAt,
});

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    date: "2026-11-11", // a Wednesday
    isRestDay: false,
    recentEnergy: [2, 3],
    template: templateFor(3),
    kept: [],
    areas: AREAS,
    doneThisWeekMin: {},
    tasks: [],
    chosenTop: [],
    ...overrides,
  };
}

const areaBlocks = (plan: ReturnType<typeof generateDay>) =>
  plan.blocks.filter((block) => block.kind === "area");

describe("generateDay", () => {
  it("copies the fixed and routine blocks", () => {
    const plan = generateDay(input());
    const titles = plan.blocks.filter((b) => b.kind !== "area").map((b) => b.title);
    expect(titles).toEqual([
      "Quran",
      "Job A",
      "Check email",
      "Job B",
      "Check email",
      "Gym",
      "Night review",
    ]);
  });

  it("gives focus blocks to the areas furthest behind", () => {
    const plan = generateDay(
      input({ doneThisWeekMin: { jobhunt: 240, coding: 0, experiments: 0, admin: 140 } }),
    );
    // Job hunt and admin are done for the week; coding and experiments are 100% behind,
    // and coding wins the tie on priority.
    expect(areaBlocks(plan).map((b) => b.areaId)).toEqual(["coding", "experiments"]);
  });

  it("stops a capped area at its target", () => {
    const plan = generateDay(
      input({ doneThisWeekMin: { jobhunt: 240, coding: 240, admin: 140, experiments: 170 } }),
    );
    const experiments = areaBlocks(plan).filter((b) => b.areaId === "experiments");
    expect(experiments.reduce((sum, b) => sum + b.durationMin, 0)).toBeLessThanOrEqual(10 + 0);
  });

  it("keeps at least 20% of free time open", () => {
    const plan = generateDay(input());
    const slots = templateFor(3).filter((b) => b.kind === "area");
    const free = slots.reduce((sum, b) => sum + b.durationMin, 0);
    const used = areaBlocks(plan).reduce((sum, b) => sum + b.durationMin, 0);
    expect(used).toBeLessThanOrEqual(free * 0.8);
  });

  it("puts an area with a task due within 48 hours first", () => {
    const plan = generateDay(
      input({ tasks: [task("cv", "jobhunt", "2026-11-12")], doneThisWeekMin: { jobhunt: 200 } }),
    );
    expect(areaBlocks(plan)[0]).toMatchObject({
      areaId: "jobhunt",
      taskId: "cv",
      title: "Job hunt: cv",
    });
  });

  it("assigns tasks to their area's block, deadline first then oldest", () => {
    const plan = generateDay(
      input({
        tasks: [
          task("old", "coding", null, 1),
          task("due", "coding", "2026-11-20", 5),
          task("new", "coding", null, 9),
        ],
        doneThisWeekMin: { jobhunt: 240, experiments: 180, admin: 140 },
      }),
    );
    expect(areaBlocks(plan).map((b) => b.taskId)).toEqual(["due", "old"]);
  });

  it("makes a light day after two drained nights: routines and one top task", () => {
    const plan = generateDay(
      input({
        recentEnergy: [1, 1],
        tasks: [task("a", "coding", "2026-11-11"), task("b", "coding", "2026-11-11")],
      }),
    );
    expect(plan.light).toBe(true);
    expect(areaBlocks(plan)).toEqual([]);
    expect(plan.top).toHaveLength(1);
  });

  it("treats the rest day as light", () => {
    const plan = generateDay(input({ isRestDay: true, template: templateFor(7) }));
    expect(plan.light).toBe(true);
    expect(plan.blocks.map((b) => b.title)).toEqual(["Quran", "Rest day", "Night review"]);
  });

  it("plans around blocks you edited", () => {
    const evening = templateFor(3).find((b) => b.kind === "area" && b.startMin >= 18 * 60);
    expect(evening).toBeDefined();
    const plan = generateDay(
      input({
        kept: evening ? [{ startMin: evening.startMin, durationMin: evening.durationMin }] : [],
      }),
    );
    expect(areaBlocks(plan).some((b) => evening && b.startMin === evening.startMin)).toBe(false);
  });

  it("orders the top 3: last night's choice, then deadlines, then area work", () => {
    const plan = generateDay(
      input({
        chosenTop: ["picked"],
        tasks: [
          task("picked", "coding"),
          task("due", "admin", "2026-11-11"),
          task("work", "jobhunt"),
        ],
        doneThisWeekMin: { coding: 240, admin: 140, experiments: 180 },
      }),
    );
    expect(plan.top).toEqual(["picked", "due", "work"]);
  });

  it("never plans an inactive area", () => {
    const plan = generateDay(
      input({ areas: AREAS.map((a) => (a.id === "coding" ? { ...a, active: false } : a)) }),
    );
    expect(areaBlocks(plan).some((b) => b.areaId === "coding")).toBe(false);
  });

  it("gives a free Saturday three area blocks across different areas", () => {
    const plan = generateDay(input({ date: "2026-11-14", template: templateFor(6) }));
    const areas = areaBlocks(plan).map((b) => b.areaId);
    expect(new Set(areas).size).toBe(areas.length);
  });
});

describe("an editable routine (My week)", () => {
  const first = {
    startMin: 19 * 60,
    durationMin: 60,
    kind: "area" as const,
    areaId: null,
    title: "Focus block",
  };
  const second = {
    startMin: 20 * 60 + 15,
    durationMin: 45,
    kind: "area" as const,
    areaId: null,
    title: "Focus block",
  };
  const twoSlots = [first, second];

  it("gives a slot tied to an area that area", () => {
    const tied = [{ ...first, areaId: "gym" }];
    const plan = generateDay(input({ template: tied }));
    expect(areaBlocks(plan).map((b) => b.areaId)).toEqual(["gym"]);
  });

  it("puts a task with no area into a slot whose area has none", () => {
    const plan = generateDay(input({ template: [first], tasks: [task("Call the bank", null)] }));
    expect(areaBlocks(plan)[0]?.taskId).toBe("Call the bank");
  });

  it("keeps a big task going into the next slot, then stops when its time is covered", () => {
    const big = { ...task("Write the report", null), remainingMin: 90 };
    const other = task("Small one", null, null, 5);
    const plan = generateDay(input({ template: twoSlots, tasks: [big, other] }));
    // The budget keeps 20% free: 105 min of slots → 84 planned: 60 + 24 (too short, 25 is the floor).
    expect(areaBlocks(plan).map((b) => b.taskId)).toEqual(["Write the report"]);
    const roomy = generateDay(
      input({
        template: [...twoSlots, { ...second, startMin: 21 * 60 + 30, durationMin: 60 }],
        tasks: [big, other],
      }),
    );
    expect(areaBlocks(roomy).map((b) => b.taskId)).toEqual([
      "Write the report",
      "Write the report",
      "Small one",
    ]);
  });
});

describe("tied slots and time off", () => {
  const slot = (startMin: number, areaId: string | null = null) => ({
    startMin,
    durationMin: 60,
    kind: "area" as const,
    areaId,
    title: "Focus block",
  });

  it("fills a tied slot even when earlier slots used the buffer", () => {
    const plan = generateDay(
      input({ template: [slot(17 * 60), slot(18 * 60), slot(19 * 60, "gym")] }),
    );
    expect(areaBlocks(plan).map((b) => b.areaId)).toContain("gym");
  });

  it("plans nothing in a slot that overlaps time off", () => {
    const off = {
      startMin: 17 * 60,
      durationMin: 120,
      kind: "rest" as const,
      areaId: null,
      title: "Off",
    };
    const plan = generateDay(input({ template: [off, slot(17 * 60 + 30), slot(20 * 60)] }));
    expect(areaBlocks(plan).map((b) => b.startMin)).toEqual([20 * 60]);
  });
});

describe("calendar events", () => {
  const slot = (startMin: number, durationMin: number) => ({
    startMin,
    durationMin,
    kind: "area" as const,
    areaId: null,
    title: "Focus block",
  });

  it("adds events as fixed blocks and plans around them", () => {
    const plan = generateDay(
      input({
        template: [slot(9 * 60, 180)],
        events: [{ startMin: 10 * 60, durationMin: 60, title: "Dentist" }],
      }),
    );
    expect(plan.blocks.find((b) => b.title === "Dentist")).toMatchObject({
      kind: "fixed",
      startMin: 600,
      durationMin: 60,
    });
    for (const block of areaBlocks(plan))
      expect(block.startMin + block.durationMin <= 600 || block.startMin >= 660).toBe(true);
    expect(areaBlocks(plan).length).toBeGreaterThan(0);
  });

  it("drops a leftover too short to use", () => {
    const plan = generateDay(
      input({
        template: [slot(9 * 60, 60)],
        events: [{ startMin: 9 * 60 + 20, durationMin: 40, title: "Call" }],
      }),
    );
    expect(areaBlocks(plan)).toEqual([]);
  });

  it("lets a block you edited win over an event", () => {
    const plan = generateDay(
      input({
        template: [],
        kept: [{ startMin: 600, durationMin: 60 }],
        events: [{ startMin: 600, durationMin: 30, title: "Clash" }],
      }),
    );
    expect(plan.blocks.some((b) => b.title === "Clash")).toBe(false);
  });
});

describe("cut", () => {
  it("takes busy time out of a slot", () => {
    expect(
      cut({ startMin: 0, durationMin: 100 }, [
        { startMin: 20, durationMin: 10 },
        { startMin: 90, durationMin: 30 },
      ]),
    ).toEqual([
      { startMin: 0, durationMin: 20 },
      { startMin: 30, durationMin: 60 },
    ]);
    expect(cut({ startMin: 0, durationMin: 60 }, [{ startMin: 0, durationMin: 60 }])).toEqual([]);
  });
});
