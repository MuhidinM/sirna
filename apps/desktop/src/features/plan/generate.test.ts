import { describe, expect, it } from "vitest";

import {
  type AreaInput,
  cut,
  firstGap,
  generateDay,
  type PlanInput,
  type TaskInput,
} from "./generate";
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

  it("never puts a task with no area into an area block (time first, rule 4)", () => {
    const plan = generateDay(input({ template: [first], tasks: [task("Call the bank", null)] }));
    expect(areaBlocks(plan).length).toBeGreaterThan(0);
    expect(plan.blocks.some((b) => b.taskId === "Call the bank")).toBe(false);
  });

  it("keeps a big task going into the next slot, then stops when its time is covered", () => {
    const big = { ...task("Write the report", "coding"), remainingMin: 90 };
    const other = task("Small one", "coding", null, 5);
    const coding = (slot: typeof first) => ({ ...slot, areaId: "coding" });
    const plan = generateDay(input({ template: twoSlots.map(coding), tasks: [big, other] }));
    // The budget keeps 20% free: 105 min of slots → 84 planned: 60 + 24 (too short, 25 is the floor).
    expect(areaBlocks(plan).map((b) => b.taskId)).toEqual(["Write the report"]);
    const roomy = generateDay(
      input({
        template: [...twoSlots, { ...second, startMin: 21 * 60 + 30, durationMin: 60 }].map(coding),
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

describe("time first (docs/proposals/time-first.md §1)", () => {
  const slot = (startMin: number, durationMin: number, areaId: string | null = null) => ({
    startMin,
    durationMin,
    kind: "area" as const,
    areaId,
    title: "Focus block",
  });
  /** Every fillable area has met its week: slots stay free unless a task takes them. */
  const metWeek = { jobhunt: 240, coding: 240, experiments: 180, admin: 140 };
  const ownBlocks = (plan: ReturnType<typeof generateDay>) => plan.blocks.filter((b) => b.fromTask);

  it("gives a timed task its own block at its time, out of the focus slots (rule 1)", () => {
    const call = { ...task("Call bank", null), atMin: 15 * 60, estimateMin: 60 };
    const plan = generateDay(input({ template: [slot(14 * 60, 180)], tasks: [call] }));
    expect(plan.blocks.find((b) => b.taskId === "Call bank")).toEqual({
      startMin: 900,
      durationMin: 60,
      kind: "area",
      areaId: null,
      taskId: "Call bank",
      title: "Call bank",
      fromTask: true,
    });
    const others = areaBlocks(plan).filter((b) => b.taskId !== "Call bank");
    expect(others.length).toBeGreaterThan(0);
    for (const block of others)
      expect(block.startMin + block.durationMin <= 900 || block.startMin >= 960).toBe(true);
  });

  it("makes a timed block 30 minutes without an estimate and keeps the task's area", () => {
    const cv = { ...task("cv", "jobhunt"), atMin: 10 * 60 };
    const plan = generateDay(input({ template: [slot(9 * 60, 180)], tasks: [cv] }));
    expect(plan.blocks.filter((b) => b.taskId === "cv")).toEqual([
      expect.objectContaining({ startMin: 600, durationMin: 30, areaId: "jobhunt", title: "cv" }),
    ]);
  });

  it("may put a timed block beside a fixed block", () => {
    const job = { ...slot(8 * 60, 540, "joba"), kind: "fixed" as const, title: "Job A" };
    const plan = generateDay(
      input({ template: [job], tasks: [{ ...task("Dentist call", null), atMin: 11 * 60 }] }),
    );
    expect(plan.blocks.map((b) => b.title)).toEqual(["Job A", "Dentist call"]);
  });

  it("keeps a timed task on a light day", () => {
    const plan = generateDay(
      input({ recentEnergy: [1, 1], tasks: [{ ...task("Pharmacy", null), atMin: 18 * 60 }] }),
    );
    expect(plan.light).toBe(true);
    expect(ownBlocks(plan).map((b) => b.taskId)).toEqual(["Pharmacy"]);
  });

  it("doesn't make a block the same as one already there", () => {
    const gym = { ...slot(18 * 60, 60, "gym"), kind: "routine" as const, title: "Gym" };
    const plan = generateDay(
      input({ template: [gym], tasks: [{ ...task("Gym", "gym"), atMin: 18 * 60 }] }),
    );
    expect(plan.blocks.filter((b) => b.title === "Gym")).toHaveLength(1);
  });

  it("puts a part-of-day task into the first free gap in its window (rule 2)", () => {
    const gym = { ...slot(17 * 60, 70, "gym"), kind: "routine" as const, title: "Gym" };
    const read = { ...task("Read", null), window: "evening" as const, estimateMin: 45 };
    const plan = generateDay(
      input({ template: [gym, slot(19 * 60, 120)], tasks: [read], doneThisWeekMin: metWeek }),
    );
    // Gym ends 18:10; the next quarter hour is 18:15.
    expect(plan.blocks.find((b) => b.taskId === "Read")).toMatchObject({
      startMin: 18 * 60 + 15,
      durationMin: 45,
      areaId: null,
    });
  });

  it("starts a window no earlier than notBeforeMin, and leaves a task with no room alone", () => {
    const read = { ...task("Read", null), window: "morning" as const };
    const later = generateDay(input({ template: [], tasks: [read], notBeforeMin: 9 * 60 + 5 }));
    expect(later.blocks.find((b) => b.taskId === "Read")?.startMin).toBe(9 * 60 + 15);
    const shift = { ...slot(6 * 60, 360), kind: "fixed" as const, title: "Shift" };
    const none = generateDay(input({ template: [shift], tasks: [read] }));
    expect(none.blocks.some((b) => b.taskId === "Read")).toBe(false);
  });

  it("gives an untimed task with no area and an estimate a neutral block (rule 5)", () => {
    const bank = { ...task("Call the bank", null), estimateMin: 90, remainingMin: 90 };
    const plan = generateDay(
      input({ template: [slot(19 * 60, 60)], tasks: [bank], doneThisWeekMin: metWeek }),
    );
    // 60 free minutes, 20% kept open: 48 for the task.
    expect(ownBlocks(plan)).toEqual([
      expect.objectContaining({ startMin: 19 * 60, durationMin: 48, areaId: null, kind: "area" }),
    ]);
  });

  it("fills area slots first; a neutral block only gets what they leave", () => {
    const bank = { ...task("Call the bank", null), estimateMin: 30, remainingMin: 30 };
    const busy = generateDay(input({ template: [slot(19 * 60, 60)], tasks: [bank] }));
    expect(ownBlocks(busy)).toEqual([]);
    const roomy = generateDay(
      input({
        template: [slot(9 * 60, 120)],
        tasks: [bank],
        doneThisWeekMin: { ...metWeek, coding: 200 },
        areas: AREAS.map((a) => (a.id === "coding" ? { ...a, capped: true } : a)),
      }),
    );
    // Coding takes its last 40 minutes, the bank call the next 30.
    expect(areaBlocks(roomy).map((b) => [b.startMin, b.durationMin, b.taskId])).toEqual([
      [540, 40, null],
      [580, 30, "Call the bank"],
    ]);
  });

  it("keeps a task with no area, no time and no estimate as a list item only", () => {
    const plan = generateDay(
      input({
        template: [slot(19 * 60, 60)],
        tasks: [task("Buy milk", null)],
        doneThisWeekMin: metWeek,
      }),
    );
    expect(plan.blocks.some((b) => b.taskId === "Buy milk")).toBe(false);
  });

  it("doesn't remake a task block you moved", () => {
    const call = { ...task("Call bank", null), atMin: 15 * 60 };
    const plan = generateDay(
      input({
        template: [],
        tasks: [call],
        kept: [{ startMin: 16 * 60, durationMin: 30, taskId: "Call bank" }],
      }),
    );
    expect(plan.blocks.some((b) => b.taskId === "Call bank")).toBe(false);
  });
});

describe("firstGap", () => {
  it("finds the first quarter hour where the length fits", () => {
    const busy = [
      { startMin: 360, durationMin: 50 },
      { startMin: 420, durationMin: 60 },
    ];
    expect(firstGap(busy, 30, 360, 720)).toBe(480);
    expect(firstGap([], 30, 361, 720)).toBe(375);
    expect(firstGap(busy, 300, 360, 720)).toBeNull();
  });
});

describe("time first: review fixes", () => {
  it("cuts a timed block at the end of its logical day (03:00)", () => {
    const late = { ...task("Night call", null), atMin: 26 * 60 + 30, estimateMin: 90 };
    const plan = generateDay(input({ template: [], tasks: [late] }));
    expect(plan.blocks.find((b) => b.taskId === "Night call")).toMatchObject({
      startMin: 26 * 60 + 30,
      durationMin: 30,
    });
  });

  it("doesn't make again a task block you deleted", () => {
    const call = { ...task("Call bank", null), atMin: 15 * 60 };
    const plan = generateDay(input({ tasks: [call], removedTaskIds: ["Call bank"] }));
    expect(plan.blocks.some((b) => b.taskId === "Call bank")).toBe(false);
  });
});

describe("blocks you deleted", () => {
  it("doesn't copy a deleted routine block again, only that one", () => {
    const template = templateFor(3);
    const email = template.find((b) => b.title === "Check email");
    if (!email) throw new Error("expected a Check email block");
    const plan = generateDay(
      input({
        removedBlocks: [
          {
            startMin: email.startMin,
            durationMin: email.durationMin,
            kind: "routine",
            title: "Check email",
          },
        ],
      }),
    );
    const emails = plan.blocks.filter((b) => b.title === "Check email");
    expect(emails).toHaveLength(template.filter((b) => b.title === "Check email").length - 1);
    expect(emails.some((b) => b.startMin === email.startMin)).toBe(false);
  });

  it("leaves a deleted area block's time empty", () => {
    const first = areaBlocks(generateDay(input()))[0];
    if (!first) throw new Error("expected an area block");
    const plan = generateDay(
      input({
        removedBlocks: [
          {
            startMin: first.startMin,
            durationMin: first.durationMin,
            kind: "area",
            title: first.title,
          },
        ],
      }),
    );
    expect(
      areaBlocks(plan).some(
        (b) =>
          b.startMin < first.startMin + first.durationMin &&
          first.startMin < b.startMin + b.durationMin,
      ),
    ).toBe(false);
  });
});

describe("a block you added by hand", () => {
  it("stands in for a task with the same title and time, so a re-plan never clashes", () => {
    const call = { ...task("Call bank", null), atMin: 15 * 60, estimateMin: 30 };
    const plan = generateDay(
      input({ tasks: [call], kept: [{ startMin: 15 * 60, durationMin: 30, title: "Call bank" }] }),
    );
    expect(plan.blocks.filter((block) => block.title === "Call bank")).toHaveLength(0);
  });
});

describe("a routine or calendar block you moved", () => {
  it("isn't copied again at its old time", () => {
    const template = templateFor(3);
    const quran = template.find((b) => b.title === "Quran");
    if (!quran) throw new Error("expected a Quran block");
    const moved = {
      startMin: quran.startMin + 60,
      durationMin: 20,
      title: "Quran",
      kind: "routine" as const,
    };
    const plan = generateDay(input({ kept: [moved] }));
    expect(plan.blocks.filter((b) => b.title === "Quran")).toEqual([]);
  });

  it("stands for one block only: the other one of the same name stays", () => {
    const emails = templateFor(3).filter((b) => b.title === "Check email");
    const [early, late] = emails;
    if (!early || !late) throw new Error("expected two Check email blocks");
    const moved = {
      startMin: early.startMin + 30,
      durationMin: 10,
      title: "Check email",
      kind: "routine" as const,
    };
    const plan = generateDay(input({ kept: [moved] }));
    expect(plan.blocks.filter((b) => b.title === "Check email").map((b) => b.startMin)).toEqual([
      late.startMin,
    ]);
  });

  it("an event you moved isn't copied again at its old time", () => {
    const plan = generateDay(
      input({
        template: [],
        events: [{ startMin: 600, durationMin: 60, title: "Dentist" }],
        kept: [{ startMin: 900, durationMin: 60, title: "Dentist", kind: "fixed" }],
      }),
    );
    expect(plan.blocks.some((b) => b.title === "Dentist")).toBe(false);
  });
});
