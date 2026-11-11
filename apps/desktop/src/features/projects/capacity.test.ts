import { describe, expect, it } from "vitest";

import { DEFAULT_ANSWERS, defaultRoutine, toMinutes } from "../plan/routine";
import {
  admitStatus,
  areaCommitted,
  checkWithDate,
  findSlot,
  firstMonday,
  freeMinutes,
  hoursLabel,
  type PlannedProject,
  type Query,
  type TemplateBlock,
  type Verdict,
  weeklyCapacity,
  weekLoad,
} from "./capacity";

/**
 * Hand-checked fixtures (T-034). One week model throughout: 1000 minutes of
 * capacity, 500 already committed by areas, so 350 minutes fit under 85%.
 * Today is Wednesday 2026-11-11; the first full week starts Mon 16 Nov.
 */
const TODAY = "2026-11-11";
const WEEK = { capacity: 1000, areaCommitted: 500 };

const project = (change: Partial<PlannedProject>): PlannedProject => ({
  id: "p",
  status: "active",
  weekly_min: 100,
  start_date: null,
  forecast_finish: null,
  ...change,
});
const twoActive = [project({ id: "a" }), project({ id: "b" })];

describe("ideas with a date", () => {
  const cases: {
    name: string;
    estimate: number;
    deadline: string;
    projects?: PlannedProject[];
    week?: typeof WEEK;
    weekly: number;
    after: number;
    verdict: Verdict;
  }[] = [
    // 40 days to 20 Dec = 5.71 weeks.
    {
      name: "1 small, roomy",
      estimate: 600,
      deadline: "2026-12-20",
      weekly: 105,
      after: 0.605,
      verdict: "good",
    },
    {
      name: "2 just under 85%",
      estimate: 1800,
      deadline: "2026-12-20",
      weekly: 315,
      after: 0.815,
      verdict: "good",
    },
    {
      name: "3 over 85%",
      estimate: 2100,
      deadline: "2026-12-20",
      weekly: 368,
      after: 0.868,
      verdict: "tight",
    },
    {
      name: "4 over 100%",
      estimate: 3000,
      deadline: "2026-12-20",
      weekly: 525,
      after: 1.025,
      verdict: "too_much",
    },
    {
      name: "5 at 99%",
      estimate: 2800,
      deadline: "2026-12-20",
      weekly: 490,
      after: 0.99,
      verdict: "tight",
    },
    {
      name: "6 a third project",
      estimate: 600,
      deadline: "2026-12-20",
      projects: twoActive,
      weekly: 105,
      after: 0.805,
      verdict: "tight",
    },
    // 62 days to 11 Jan = 8.86 weeks.
    {
      name: "9 far date",
      estimate: 1500,
      deadline: "2027-01-11",
      weekly: 170,
      after: 0.67,
      verdict: "good",
    },
    // Due today: the whole estimate counts against this week.
    {
      name: "8 due today",
      estimate: 300,
      deadline: TODAY,
      weekly: 300,
      after: 0.8,
      verdict: "good",
    },
  ];
  it.each(cases)(
    "$name",
    ({ estimate, deadline, projects = [], week = WEEK, weekly, after, verdict }) => {
      const check = checkWithDate(estimate, deadline, TODAY, week, projects);
      expect(check.weeklyNeeded).toBe(weekly);
      expect(check.after).toBeCloseTo(after, 3);
      expect(check.verdict).toBe(verdict);
    },
  );

  it("7 a date that has passed is too much", () => {
    const check = checkWithDate(600, "2026-11-10", TODAY, WEEK, []);
    expect(check.verdict).toBe("too_much");
    expect(check.reasons).toEqual(["The date has passed."]);
  });

  it("10 no free time at all is too much", () => {
    expect(
      checkWithDate(60, "2026-12-20", TODAY, { capacity: 0, areaCommitted: 0 }, []).verdict,
    ).toBe("too_much");
  });

  it("explains itself with the numbers", () => {
    expect(checkWithDate(1800, "2026-12-20", TODAY, WEEK, twoActive).reasons).toEqual([
      "Needs 5 h 15 a week for 5.5 weeks.",
      "Your load would go 70% → 101%.",
      "2 active projects already; this would be number 3.",
    ]);
  });

  it("suggests the slot finder's dates", () => {
    expect(checkWithDate(600, "2026-12-20", TODAY, WEEK, []).suggestion).toMatchObject({
      start: "2026-11-16",
      finish: "2026-11-29",
    });
  });
});

describe("ideas without a date (slot finder)", () => {
  const cases: {
    name: string;
    estimate: number;
    weeklyMin?: number;
    projects?: PlannedProject[];
    week?: typeof WEEK;
    today?: string;
    slot: { start: string; finish: string; weeks: number[] } | null;
  }[] = [
    {
      name: "11 fills two weeks",
      estimate: 600,
      slot: { start: "2026-11-16", finish: "2026-11-29", weeks: [350, 250] },
    },
    {
      name: "12 at the hours asked for",
      estimate: 600,
      weeklyMin: 120,
      slot: { start: "2026-11-16", finish: "2026-12-20", weeks: [120, 120, 120, 120, 120] },
    },
    {
      name: "13 fits in a week",
      estimate: 300,
      slot: { start: "2026-11-16", finish: "2026-11-22", weeks: [300] },
    },
    {
      name: "14 shares with an active project",
      estimate: 600,
      projects: [project({ id: "a" })],
      slot: { start: "2026-11-16", finish: "2026-12-06", weeks: [250, 250, 100] },
    },
    {
      name: "15 two active projects that never end",
      estimate: 600,
      projects: twoActive,
      slot: null,
    },
    {
      name: "16 waits for a project to finish",
      estimate: 400,
      projects: [project({ id: "a" }), project({ id: "b", forecast_finish: "2026-11-29" })],
      slot: { start: "2026-11-30", finish: "2026-12-13", weeks: [250, 150] },
    },
    {
      name: "17 no room left",
      estimate: 600,
      week: { capacity: 1000, areaCommitted: 830 },
      slot: null,
    },
    {
      name: "18 a small last piece still finishes",
      estimate: 360,
      slot: { start: "2026-11-16", finish: "2026-11-29", weeks: [350, 10] },
    },
    {
      name: "19 makes room for a project starting later",
      estimate: 500,
      projects: [
        project({ id: "n", status: "next_up", start_date: "2026-11-23", weekly_min: 200 }),
      ],
      slot: { start: "2026-11-16", finish: "2026-11-29", weeks: [350, 150] },
    },
    {
      name: "20 starts today on a Monday",
      estimate: 100,
      today: "2026-11-16",
      slot: { start: "2026-11-16", finish: "2026-11-22", weeks: [100] },
    },
    {
      name: "21 pauses through a full week, then finishes",
      estimate: 500,
      projects: [
        project({
          id: "n",
          status: "next_up",
          start_date: "2026-11-23",
          forecast_finish: "2026-11-29",
          weekly_min: 350,
        }),
      ],
      slot: { start: "2026-11-16", finish: "2026-12-06", weeks: [350, 0, 150] },
    },
    {
      name: "22 paused and done projects take no time",
      estimate: 350,
      projects: [project({ id: "a", status: "paused" }), project({ id: "b", status: "done" })],
      slot: { start: "2026-11-16", finish: "2026-11-22", weeks: [350] },
    },
  ];
  it.each(cases)(
    "$name",
    ({ estimate, weeklyMin, projects = [], week = WEEK, today = TODAY, slot }) => {
      const found = findSlot(estimate, today, week, projects, weeklyMin ?? null);
      if (slot === null) expect(found).toBeNull();
      else expect(found).toMatchObject(slot);
    },
  );

  it("never pushes a week past 85%", () => {
    const projects = [project({ id: "a", weekly_min: 180 })];
    const slot = findSlot(2000, TODAY, WEEK, projects);
    expect(slot).not.toBeNull();
    for (const given of slot?.weeks ?? []) {
      expect(WEEK.areaCommitted + 180 + given).toBeLessThanOrEqual(850);
    }
  });
});

describe("the template week", () => {
  const blocks = defaultRoutine(DEFAULT_ANSWERS).map((block): TemplateBlock => ({
    weekday: block.weekday,
    start_min: block.startMin,
    duration_min: block.durationMin,
    kind: block.kind,
    area_id: block.areaId,
  }));
  const window = {
    fromMin: toMinutes(DEFAULT_ANSWERS.wake) + 30,
    toMin: Math.min(toMinutes(DEFAULT_ANSWERS.review), toMinutes(DEFAULT_ANSWERS.hardStop)),
  };

  it("counts free time by hand: 06:30–21:00 less jobs and gym, rest day off", () => {
    // Mon/Wed/Fri 870 − 480 jobs − 45 gym = 345; Tue/Thu 870 − 480 = 390;
    // Sat 870; Sun rest. Email checks sit inside the jobs; Quran is before 06:30.
    expect(freeMinutes(blocks, window)).toBe(3 * 345 + 2 * 390 + 870);
    expect(weeklyCapacity(blocks, window)).toBe(Math.round(2685 * 0.8));
  });

  it("counts what areas still need beyond their routines", () => {
    const areas = [
      { id: "jobhunt", weekly_target_min: 240, active: 1 },
      { id: "coding", weekly_target_min: 240, active: 1 },
      { id: "experiments", weekly_target_min: 180, active: 1 },
      { id: "gym", weekly_target_min: 135, active: 1 }, // 3 × 45 in the routine
      { id: "quran", weekly_target_min: 140, active: 1 }, // 7 × 20 in the routine
      { id: "admin", weekly_target_min: 140, active: 1 }, // 10 email checks = 100
      { id: "joba", weekly_target_min: 0, active: 1 },
      { id: "old", weekly_target_min: 500, active: 0 },
    ];
    expect(areaCommitted(areas, blocks)).toBe(240 + 240 + 180 + 0 + 0 + 40);
  });
});

describe("helpers", () => {
  it("loads a week", () => {
    expect(weekLoad(WEEK, [project({ id: "a" })], "2026-11-16")).toMatchObject({
      committed: 600,
      ratio: 0.6,
      activeProjects: 1,
    });
  });

  it("finds the first Monday", () => {
    expect(firstMonday("2026-11-11")).toBe("2026-11-16");
    expect(firstMonday("2026-11-16")).toBe("2026-11-16");
    expect(firstMonday("2026-11-22")).toBe("2026-11-23");
  });

  it("holds a third active project in Next up", () => {
    expect(admitStatus("active", twoActive, null)).toEqual({ status: "next_up", held: true });
    expect(admitStatus("active", twoActive, "a")).toEqual({ status: "active", held: false });
    expect(admitStatus("idea", twoActive, null)).toEqual({ status: "idea", held: false });
  });

  it("labels hours", () => {
    expect(hoursLabel(315)).toBe("5 h 15");
    expect(hoursLabel(120)).toBe("2 h");
    expect(hoursLabel(45)).toBe("45 min");
  });
});

describe("loading the week from the database", () => {
  it("matches the hand count on a fresh setup", async () => {
    const { openTestDb } = await import("../../test/sqlite");
    const { setupOps } = await import("../plan/setup");
    const db = openTestDb();
    let n = 0;
    const ops = setupOps(
      { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
      [],
      [],
      () => `r${++n}`,
    );
    for (const op of ops) {
      if (op.op === "delete") continue;
      const values = { ...op.values, created_at: 0, updated_at: 0 } as Record<
        string,
        string | number | null
      >;
      const key = op.table === "core_settings" ? "key" : "id";
      if (op.op === "insert") {
        const names = [key, ...Object.keys(values)];
        db.prepare(
          `INSERT INTO ${op.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        ).run(op.id, ...Object.values(values));
      } else if (op.op === "upsert") {
        const { created_at: _created, ...rest } = values;
        const names = [key, ...Object.keys(rest)];
        db.prepare(
          `INSERT OR REPLACE INTO ${op.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        ).run(op.id, ...Object.values(rest));
      } else {
        const names = Object.keys(values).filter((name) => name !== "created_at");
        db.prepare(
          `UPDATE ${op.table} SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE ${key} = ?`,
        ).run(...names.map((name) => values[name] ?? null), op.id);
      }
    }
    const query: Query = (sql, params = []) =>
      Promise.resolve(db.prepare(sql).all(...params) as never);
    const { loadWeek } = await import("./capacity");
    const { week, projects } = await loadWeek(query);
    expect(week.capacity).toBe(2148);
    expect(projects).toEqual([]);
  });
});

describe("review fixes", () => {
  it("judges the busiest week before the deadline", () => {
    const later = project({
      id: "n",
      status: "next_up",
      start_date: "2026-11-23",
      weekly_min: 300,
    });
    const check = checkWithDate(1800, "2026-12-20", TODAY, WEEK, [later]);
    // 500 areas + 300 from 23 Nov + 315 needed = 1115 of 1000.
    expect(check.after).toBeCloseTo(1.115, 3);
    expect(check.verdict).toBe("too_much");
    expect(check.reasons[1]).toBe("Your load would go 50% → 112% in the week of 2026-11-23.");
  });

  it("never runs as a third project, even after it started", () => {
    const later = project({ id: "n", status: "next_up", start_date: "2026-11-23", weekly_min: 50 });
    const slot = findSlot(1000, TODAY, WEEK, [project({ id: "a" }), later]);
    // Week of 16 Nov: only a runs, so 250 fits; from 23 Nov a and n run: it waits.
    expect(slot).toBeNull();
    const ends = { ...later, forecast_finish: "2026-11-29" };
    expect(findSlot(1000, TODAY, WEEK, [project({ id: "a" }), ends])).toMatchObject({
      start: "2026-11-16",
      weeks: [250, 0, 250, 250, 250],
    });
  });
});
