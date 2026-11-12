import { describe, expect, it } from "vitest";

import { openTestDb } from "../../test/sqlite";
import {
  AREA_WEEK_SQL,
  type AreaWeek,
  dismissOps,
  FOCUS_WEEK_SQL,
  type FocusWeek,
  historyWeeks,
  isHandled,
  applyOps,
  nextWeek,
  oneChange,
  progressLabel,
  PROJECTS_WEEK_SQL,
  type ProjectWeek,
  SPEND_SINCE_SQL,
  SPEND_SQL,
  spendLines,
  spendParams,
  type SpendRow,
} from "./card";

// The week of Mon 9 – Sun 15 Nov 2026; it is Sunday 15 Nov, 20:00 in Addis (17:00 UTC).
const MONDAY = "2026-11-09";
const WEEK_START = Date.parse("2026-11-09T00:00:00Z"); // 03:00 Addis: the logical day starts then
const NOW = Date.parse("2026-11-15T17:00:00Z");
const at = (iso: string) => Date.parse(`${iso}Z`);

/** A hand-countable week: every number below is checked by hand in the tests. */
function seeded() {
  const db = openTestDb();
  db.exec(`
    -- Coding: two finished sessions of 50 min, one paused 20 min (so 30), one last week.
    INSERT INTO focus_sessions (id, area_id, kind, started_at, planned_min, ended_at, paused_ms, outcome, distractions, overrun) VALUES
      ('f1', 'coding', 'focus', ${at("2026-11-10T16:00:00")}, 50, ${at("2026-11-10T16:50:00")}, 0, 'completed', 1, 0),
      ('f2', 'coding', 'focus', ${at("2026-11-12T16:00:00")}, 50, ${at("2026-11-12T16:50:00")}, 1200000, 'completed', 2, 1),
      ('f3', 'coding', 'focus', ${at("2026-11-02T16:00:00")}, 50, ${at("2026-11-02T16:50:00")}, 0, 'completed', 0, 1),
      ('f4', 'jobhunt', 'focus', ${at("2026-11-13T16:00:00")}, 25, ${at("2026-11-13T16:25:00")}, 0, 'completed', 0, 1),
      ('f5', 'jobhunt', 'focus', ${at("2026-11-13T17:00:00")}, 25, ${at("2026-11-13T17:25:00")}, 0, 'completed', 0, 1),
      ('b1', 'jobhunt', 'break', ${at("2026-11-13T16:25:00")}, 5, ${at("2026-11-13T16:30:00")}, 0, 'completed', 0, 0);
    -- Gym: one 45-min habit block done, one skipped.
    INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, source, status, created_at, updated_at) VALUES
      ('g1', '2026-11-09', ${at("2026-11-09T14:30:00")}, ${at("2026-11-09T15:15:00")}, 'routine', 'gym', 'Gym', 'template', 'done', 0, 0),
      ('g2', '2026-11-11', ${at("2026-11-11T14:30:00")}, ${at("2026-11-11T15:15:00")}, 'routine', 'gym', 'Gym', 'template', 'skipped', 0, 0);
    -- Money (santim): food 300 + 120 this week; food 800 and transport 400 over the 4 weeks before.
    INSERT INTO money_txns (id, occurred_at, local_date, amount_minor, description, category_id, created_at, updated_at) VALUES
      ('m1', 0, '2026-11-10', -30000, 'lunch', 'cat_food', 0, 0),
      ('m2', 0, '2026-11-14', -12000, 'coffee', 'cat_food', 0, 0),
      ('m3', 0, '2026-10-20', -80000, 'groceries', 'cat_food', 0, 0),
      ('m4', 0, '2026-10-27', -40000, 'taxi', 'cat_transport', 0, 0),
      ('m5', 0, '2026-11-12', 500000, 'salary', 'cat_salary', 0, 0),
      ('m6', 0, '2026-10-01', -99900, 'too old', 'cat_food', 0, 0);
    -- A project with 3 h estimated and one 50-min session on its card this week.
    INSERT INTO project_items (id, title, status, estimate_min, weekly_min, deadline, created_at, updated_at) VALUES
      ('p1', 'Portfolio site', 'active', 180, 120, '2026-12-20', 0, 0),
      ('p2', 'Learn Go', 'active', 600, 240, NULL, 0, 0),
      ('p3', 'Old idea', 'idea', 60, NULL, NULL, 0, 0);
    INSERT INTO task_items (id, title, project_id, created_at, updated_at) VALUES ('t1', 'Card', 'p1', 0, 0);
    UPDATE focus_sessions SET task_id = 't1' WHERE id = 'f1';
  `);
  return db;
}

describe("where time went", () => {
  it("counts focus minutes (no pauses, no breaks, this week only) and done habits", () => {
    const rows = seeded().prepare(AREA_WEEK_SQL).all(WEEK_START, NOW) as unknown as AreaWeek[];
    const done = Object.fromEntries(rows.map((r) => [r.id, r.done_min]));
    // Coding 50 + (50 − 20) = 80; Job hunt 25 + 25 = 50; Gym one 45-min block.
    expect(done).toMatchObject({ coding: 80, jobhunt: 50, gym: 45, quran: 0 });
  });

  it("counts sessions, distractions and days past the cap", () => {
    const focus = seeded().prepare(FOCUS_WEEK_SQL).get(WEEK_START, NOW) as unknown as FocusWeek;
    // f1, f2, f4, f5 this week; distractions 1 + 2; overruns on 12 and 13 Nov.
    expect(focus).toEqual({ sessions: 4, distractions: 3, overrun_days: 2 });
  });
});

describe("projects", () => {
  it("shows progress against the estimate", () => {
    const rows = seeded()
      .prepare(PROJECTS_WEEK_SQL)
      .all(WEEK_START, NOW) as unknown as ProjectWeek[];
    expect(rows.map((p) => [p.title, p.done_min, p.week_min])).toEqual([
      ["Portfolio site", 50, 50],
      ["Learn Go", 0, 0],
    ]);
    expect(progressLabel(rows[0] as ProjectWeek)).toBe("50 min of 3 h (28%)");
  });
});

describe("money", () => {
  it("compares this week with the weekly average of the 4 before", () => {
    const rows = seeded()
      .prepare(SPEND_SQL)
      .all(...spendParams(MONDAY)) as unknown as SpendRow[];
    const since = seeded()
      .prepare(SPEND_SINCE_SQL)
      .get(...spendParams(MONDAY).slice(0, 2)) as { since: string };
    expect(since.since).toBe("2026-10-20");
    const money = spendLines(rows, historyWeeks(since.since, MONDAY));
    // History starts Tue 20 Oct: 3 weeks. Food 300 + 120 = 420 ETB this week, 800 / 3 ≈ 266.67
    // a week before; transport 0 vs 400 / 3 ≈ 133.33.
    expect(money.lines).toEqual([
      { category: "Food", week: 42000, average: 26667 },
      { category: "Transport", week: 0, average: 13333 },
    ]);
    expect(money.week).toBe(42000);
    expect(money.average).toBe(40000);
  });
});

describe("one change", () => {
  const areas: AreaWeek[] = [
    { id: "coding", name: "Coding skills", color: "coding", target_min: 240, done_min: 80 },
    { id: "gym", name: "Gym", color: "gym", target_min: 135, done_min: 90 },
  ];
  const projects = [
    {
      id: "p1",
      title: "Portfolio site",
      status: "active",
      estimate_min: 180,
      weekly_min: 120,
      deadline: "2026-12-20",
      forecast_finish: null,
      done_min: 0,
      week_min: 0,
    },
    {
      id: "p2",
      title: "Learn Go",
      status: "active",
      estimate_min: 600,
      weekly_min: 240,
      deadline: null,
      forecast_finish: null,
      done_min: 0,
      week_min: 0,
    },
  ];
  const calm = { sessions: 4, distractions: 0, overrun_days: 0 };
  const light = nextWeek({ capacity: 1000, areaCommitted: 500 }, [], MONDAY);
  const heavy = nextWeek({ capacity: 1000, areaCommitted: 900 }, [], MONDAY);

  it("pauses the project without a deadline when next week is too full", () => {
    expect(heavy).toMatchObject({ monday: "2026-11-16", ratio: 0.9, over: true });
    const change = oneChange({ next: heavy, focus: calm, areas, projects, weekMostlyDone: true });
    expect(change?.text).toBe("Next week is at 90% of your free time. Pause Learn Go for now?");
    expect(change?.apply).toEqual([
      { op: "update", table: "project_items", id: "p2", values: { status: "paused" } },
    ]);
  });

  it("takes an hour off the biggest project after 3 days past the cap", () => {
    const change = oneChange({
      next: light,
      focus: { ...calm, overrun_days: 3 },
      areas,
      projects,
      weekMostlyDone: true,
    });
    expect(change?.key).toBe("less:p2");
    expect(change?.apply[0]).toMatchObject({ values: { weekly_min: 180 } });
  });

  it("offers a target an area can meet, once the week is mostly done", () => {
    const change = oneChange({ next: light, focus: calm, areas, projects, weekMostlyDone: true });
    // 80 min done × 1.25 = 100 → rounded up to 120 (2 h), under the 4 h target.
    expect(change?.text).toBe(
      "Coding skills got 1 h 20 of 4 h this week. Set its target to 2 h so it's one you can meet?",
    );
    expect(
      oneChange({ next: light, focus: calm, areas, projects, weekMostlyDone: false }),
    ).toBeNull();
  });

  it("is done for the week once applied or declined", () => {
    const [op] = dismissOps(MONDAY, "target:coding");
    const value = op && op.op === "upsert" ? String(op.values.value_json) : null;
    expect(isHandled(value, MONDAY)).toBe(true);
    expect(isHandled(value, "2026-11-16")).toBe(false);
    expect(isHandled(null, MONDAY)).toBe(false);
    const change = oneChange({ next: heavy, focus: calm, areas, projects, weekMostlyDone: true });
    if (!change) throw new Error("no change");
    const ops = applyOps(change, MONDAY);
    expect(ops.at(-1)).toMatchObject({ table: "core_settings", id: "week.change_dismissed" });
  });
});

describe("review fixes", () => {
  it("counts overrun days by the 03:00 day", () => {
    const db = openTestDb();
    // 23:30 and 01:30 Addis are the same logical day (20:30 and 22:30 UTC).
    db.exec(`INSERT INTO focus_sessions (id, kind, started_at, planned_min, ended_at, outcome, overrun) VALUES
      ('a', 'focus', ${at("2026-11-10T20:30:00")}, 25, ${at("2026-11-10T20:55:00")}, 'completed', 1),
      ('b', 'focus', ${at("2026-11-10T22:30:00")}, 25, ${at("2026-11-10T22:55:00")}, 'completed', 1)`);
    expect(
      (db.prepare(FOCUS_WEEK_SQL).get(WEEK_START, NOW) as unknown as FocusWeek).overrun_days,
    ).toBe(1);
  });

  it("leaves out the pause a running session is in", () => {
    const db = openTestDb();
    // Started 10:00, paused since 10:10, read at 11:00: 10 minutes of focus.
    db.exec(`INSERT INTO focus_sessions (id, area_id, kind, started_at, planned_min, paused_ms, paused_at) VALUES
      ('r', 'coding', 'focus', ${at("2026-11-15T07:00:00")}, 50, 0, ${at("2026-11-15T07:10:00")})`);
    const rows = db
      .prepare(AREA_WEEK_SQL)
      .all(WEEK_START, at("2026-11-15T08:00:00")) as unknown as AreaWeek[];
    expect(rows.find((r) => r.id === "coding")?.done_min).toBe(10);
  });

  it("averages over the weeks that have spending, and shows none without history", () => {
    expect(historyWeeks(null, MONDAY)).toBe(0);
    expect(historyWeeks("2026-11-03", MONDAY)).toBe(1);
    expect(historyWeeks("2026-10-12", MONDAY)).toBe(4);
    expect(spendLines([{ category: "Food", week_minor: 100, past_minor: 1000 }], 1).average).toBe(
      1000,
    );
    expect(
      spendLines([{ category: "Food", week_minor: 100, past_minor: 0 }], 0).average,
    ).toBeNull();
  });
});
