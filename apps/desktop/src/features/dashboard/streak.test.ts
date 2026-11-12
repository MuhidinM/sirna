import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  type DayFacts,
  awayDays,
  dayFacts,
  FOCUS_DAYS_SQL,
  HABIT_DAYS_SQL,
  type FocusDayRow,
  markDays,
  PLAN_DAYS_SQL,
  type PlanDayRow,
  shadeOf,
  streakOf,
  TILES_SQL,
  type Tiles,
  yearGrid,
  yearStart,
} from "./streak";

const day = (date: string, change: Partial<DayFacts> = {}): DayFacts => ({
  date,
  sessions: 0,
  focusMin: 0,
  protectedPlanned: 0,
  protectedDone: 0,
  light: false,
  rest: false,
  planned: true,
  away: false,
  ...change,
});
const good = (date: string) => day(date, { sessions: 2, focusMin: 100 });

describe("the forgiving streak", () => {
  // Mon 2 – Sun 15 Nov 2026; today is Sun 15.
  const TODAY = "2026-11-15";

  it("survives a rest day and one miss a week", () => {
    const days = [
      good("2026-11-09"),
      good("2026-11-10"),
      day("2026-11-11"), // a miss: the week's free one
      good("2026-11-12"),
      day("2026-11-13", { rest: true }),
      good("2026-11-14"),
      day("2026-11-15"), // today, not over yet
    ];
    expect(markDays(days, TODAY)).toEqual([
      "counted",
      "counted",
      "free_miss",
      "counted",
      "rest",
      "counted",
      "today",
    ]);
    expect(streakOf(days, TODAY)).toEqual({ current: 4, best: 4, freeLeft: 0, alive: true });
  });

  it("breaks on a second miss in the same week, with no red: best stays", () => {
    const days = [
      good("2026-11-09"),
      good("2026-11-10"),
      day("2026-11-11"),
      day("2026-11-12"),
      good("2026-11-13"),
    ];
    expect(streakOf(days, TODAY)).toMatchObject({ current: 1, best: 2 });
  });

  it("counts a day of protected habits done, and one session on a light day", () => {
    const days = [
      day("2026-11-09", { protectedPlanned: 2, protectedDone: 2 }),
      day("2026-11-10", { light: true, sessions: 1 }),
      day("2026-11-11", { light: true }), // light day with nothing: never breaks
      day("2026-11-12", { protectedPlanned: 2, protectedDone: 1, sessions: 1 }), // half: a miss
    ];
    expect(markDays(days, TODAY)).toEqual(["counted", "counted", "light", "free_miss"]);
  });

  it("doesn't break on days Sirna wasn't used (away)", () => {
    const days = [good("2026-11-09"), day("2026-11-10", { planned: false }), good("2026-11-11")];
    expect(streakOf(days, TODAY)).toMatchObject({ current: 2 });
  });

  it("gives a new free miss each week", () => {
    const days = [day("2026-11-06"), good("2026-11-09"), day("2026-11-10"), good("2026-11-11")];
    expect(markDays(days, TODAY)).toEqual(["free_miss", "counted", "free_miss", "counted"]);
  });
});

describe("the year chart", () => {
  it("shades by focus time", () => {
    expect([0, 30, 60, 150, 180, 400].map(shadeOf)).toEqual([0, 1, 2, 3, 4, 4]);
  });

  it("lays out 53 weeks of Monday-to-Sunday columns ending this week", () => {
    const today = "2026-11-12"; // a Thursday
    const days = [day("2026-11-10", { focusMin: 130 }), day("2026-11-09", { rest: true })];
    const grid = yearGrid(days, today);
    expect(grid).toHaveLength(53);
    const last = grid[52] ?? [];
    expect(last.map((cell) => cell.date)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(last[0]).toMatchObject({ outline: true, shade: 0 });
    expect(last[1]).toMatchObject({ minutes: 130, shade: 3 });
    expect(last.map((cell) => cell.future)).toEqual([false, false, false, false, true, true, true]);
    expect(grid[0]?.[0]?.date).toBe(yearStart(today));
  });
});

describe("reading the days", () => {
  const at = (iso: string) => Date.parse(`${iso}Z`);

  it("groups sessions and plans by the 03:00 day, with an area filter", () => {
    const db = openTestDb();
    db.exec(`
      INSERT INTO focus_sessions (id, area_id, kind, started_at, planned_min, ended_at, paused_ms, outcome, distractions) VALUES
        ('a', 'coding', 'focus', ${at("2026-11-10T20:30:00")}, 50, ${at("2026-11-10T21:20:00")}, 0, 'completed', 1),
        ('b', 'jobhunt', 'focus', ${at("2026-11-10T22:00:00")}, 25, ${at("2026-11-10T22:25:00")}, 300000, 'completed', 2),
        ('c', 'coding', 'break', ${at("2026-11-10T21:20:00")}, 10, ${at("2026-11-10T21:30:00")}, 0, 'completed', 0);
      INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, source, status, light_day, created_at, updated_at) VALUES
        ('q', '2026-11-10', 0, 1200000, 'routine', 'quran', 'Quran', 'template', 'done', 0, 0, 0),
        ('g', '2026-11-10', 0, 2700000, 'routine', 'gym', 'Gym', 'template', 'planned', 0, 0, 0),
        ('r', '2026-11-15', 0, 86400000, 'rest', NULL, 'Rest day', 'template', 'planned', 1, 0, 0);
    `);
    const all = db.prepare(FOCUS_DAYS_SQL).all("2026-11-01", "") as unknown as FocusDayRow[];
    // 23:30 and 01:00 Addis on 10–11 Nov are both the logical 10 Nov; break left out; pause off.
    expect(all).toEqual([{ date: "2026-11-10", sessions: 2, focus_min: 70 }]);
    const coding = db
      .prepare(FOCUS_DAYS_SQL)
      .all("2026-11-01", "coding") as unknown as FocusDayRow[];
    expect(coding).toEqual([{ date: "2026-11-10", sessions: 1, focus_min: 50 }]);
    const plans = db.prepare(PLAN_DAYS_SQL).all("2026-11-01") as unknown as PlanDayRow[];
    expect(plans).toEqual([
      { date: "2026-11-10", protected_planned: 2, protected_done: 1, light: 0, rest: 0 },
      { date: "2026-11-15", protected_planned: 0, protected_done: 0, light: 1, rest: 1 },
    ]);
    const days = dayFacts("2026-11-09", "2026-11-11", all, plans);
    expect(days.map((d) => [d.date, d.sessions, d.planned])).toEqual([
      ["2026-11-09", 0, false],
      ["2026-11-10", 2, true],
      ["2026-11-11", 0, false],
    ]);
    const tiles = db
      .prepare(TILES_SQL)
      .get(at("2026-11-09T00:00:00"), at("2026-11-12T00:00:00")) as unknown as Tiles;
    expect(tiles).toEqual({
      focus_min: 70,
      goal_focus_min: 70,
      break_min: 10,
      distractions: 3,
      sessions: 2,
    });
  });
});

describe("review fixes", () => {
  const at = (iso: string) => Date.parse(`${iso}Z`);
  const row = (value: string) =>
    JSON.stringify({ key: "away.until", value_json: JSON.stringify(value) });

  it("reads away days from the history of away mode", () => {
    const changes = [
      { at: at("2026-11-12T18:00:00"), after_json: row("2026-11-16") }, // away till Mon
      { at: at("2026-11-14T08:00:00"), after_json: row("") }, // back early on Sat
    ];
    expect([...awayDays(changes, "2026-11-10", "2026-11-17")]).toEqual([
      "2026-11-12",
      "2026-11-13",
    ]);
  });

  it("never breaks the streak on an away day that had a plan", () => {
    const days = [good("2026-11-09"), day("2026-11-10", { away: true }), good("2026-11-11")];
    expect(markDays(days, "2026-11-15")).toEqual(["counted", "away", "counted"]);
  });

  it("shows habit time in the chart, so habit areas aren't empty", () => {
    const db = openTestDb();
    db.exec(`INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, source, status, created_at, updated_at) VALUES
      ('q', '2026-11-10', 0, 1200000, 'routine', 'quran', 'Quran', 'template', 'done', 0, 0),
      ('g', '2026-11-10', 0, 2700000, 'routine', 'gym', 'Gym', 'template', 'skipped', 0, 0)`);
    expect(db.prepare(HABIT_DAYS_SQL).all("2026-11-01", "quran")).toEqual([
      { date: "2026-11-10", minutes: 20 },
    ]);
    const days = dayFacts(
      "2026-11-10",
      "2026-11-10",
      [],
      [],
      [{ date: "2026-11-10", minutes: 20 }],
    );
    expect(days[0]?.focusMin).toBe(20);
  });

  it("leaves a current pause out of the Focus tile", () => {
    const db = openTestDb();
    db.exec(`INSERT INTO focus_sessions (id, area_id, kind, started_at, planned_min, paused_ms, paused_at) VALUES
      ('r', 'coding', 'focus', ${at("2026-11-12T07:00:00")}, 50, 0, ${at("2026-11-12T07:10:00")})`);
    const tiles = db
      .prepare(TILES_SQL)
      .get(at("2026-11-09T00:00:00"), at("2026-11-12T07:40:00")) as unknown as Tiles;
    expect(tiles.focus_min).toBe(10);
  });
});
