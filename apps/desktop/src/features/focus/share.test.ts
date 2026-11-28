import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openTestDb } from "../../test/sqlite";
import { OPEN_TASKS_SQL } from "../plan/dayplan";
import { JOB_SHARE_MINUTES_SQL, TASK_SHARE_SQL } from "./share";

type Db = ReturnType<typeof openTestDb>;

const T0 = Date.parse("2026-11-11T09:00:00+03:00");
const min = (n: number) => T0 + n * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(min(120));
});
afterEach(() => vi.useRealTimers());

function task(db: Db, id: string, area: string | null) {
  db.prepare(
    "INSERT INTO task_items (id, title, area_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
  ).run(id, id, area);
}

/** A focus session from `from` to `to` minutes after T0, paused `pausedMin`. */
function session(
  db: Db,
  id: string,
  from: number,
  to: number,
  values: { task?: string; area?: string; pausedMin?: number } = {},
) {
  db.prepare(
    `INSERT INTO focus_sessions (id, kind, task_id, area_id, started_at, planned_min, paused_ms, ended_at, outcome)
     VALUES (?, 'focus', ?, ?, ?, ?, ?, ?, 'completed')`,
  ).run(
    id,
    values.task ?? null,
    values.area ?? null,
    min(from),
    to - from,
    (values.pausedMin ?? 0) * 60_000,
    min(to),
  );
}

function lane(db: Db, sessionId: string, taskId: string, area: string | null, position: number) {
  db.prepare(
    "INSERT INTO focus_run_tasks (session_id, task_id, area_id, position) VALUES (?, ?, ?, ?)",
  ).run(sessionId, taskId, area, position);
}

function span(db: Db, sessionId: string, taskId: string, from: number, to: number | null) {
  db.prepare(
    "INSERT INTO focus_lane_spans (session_id, task_id, start_at, end_at, end_kind) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, taskId, min(from), to === null ? null : min(to), to === null ? null : "pause");
}

function shares(db: Db, sessionId: string): Record<string, number> {
  const rows = db
    .prepare("SELECT task_id, minutes FROM v_focus_share WHERE session_id = ? ORDER BY task_id")
    .all(sessionId) as { task_id: string; minutes: number }[];
  return Object.fromEntries(rows.map((row) => [row.task_id, row.minutes]));
}

const total = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);

describe("v_focus_share", () => {
  it("splits each minute among the lanes running then; three overlapping lanes sum to the run", () => {
    const db = openTestDb();
    for (const id of ["a", "b", "c"]) task(db, id, "joba");
    session(db, "r", 0, 30, { task: "a", area: "joba" });
    lane(db, "r", "a", "joba", 1);
    lane(db, "r", "b", "jobb", 2);
    lane(db, "r", "c", "coding", 3);
    span(db, "r", "a", 0, 30); // a the whole run
    span(db, "r", "b", 10, 30); // b joins at 10
    span(db, "r", "c", 20, 30); // c joins at 20
    const got = shares(db, "r");
    // 0-10: a alone (10); 10-20: a, b (5 each); 20-30: a, b, c (10/3 each).
    expect(got.a).toBeCloseTo(10 + 5 + 10 / 3, 6);
    expect(got.b).toBeCloseTo(5 + 10 / 3, 6);
    expect(got.c).toBeCloseTo(10 / 3, 6);
    expect(total(got)).toBeCloseTo(30, 6);
  });

  it("shares minutes with no lane running across all the run's tasks", () => {
    const db = openTestDb();
    task(db, "a", null);
    task(db, "b", null);
    session(db, "r", 0, 30);
    lane(db, "r", "a", null, 1);
    lane(db, "r", "b", null, 2);
    span(db, "r", "a", 0, 10); // then nothing runs for 20 minutes
    const got = shares(db, "r");
    expect(got.a).toBeCloseTo(10 + 10, 6);
    expect(got.b).toBeCloseTo(10, 6);
    expect(total(got)).toBeCloseTo(30, 6);
  });

  it("closes a span left open at the run's end and ignores time outside the run", () => {
    const db = openTestDb();
    task(db, "a", null);
    task(db, "b", null);
    session(db, "r", 0, 20);
    lane(db, "r", "a", null, 1);
    lane(db, "r", "b", null, 2);
    span(db, "r", "a", -5, null);
    span(db, "r", "b", 10, 40);
    const got = shares(db, "r");
    expect(got.a).toBeCloseTo(15, 6);
    expect(got.b).toBeCloseTo(5, 6);
  });

  it("scales a paused run's shares to its focus time", () => {
    const db = openTestDb();
    task(db, "a", null);
    task(db, "b", null);
    session(db, "r", 0, 40, { pausedMin: 10 });
    lane(db, "r", "a", null, 1);
    lane(db, "r", "b", null, 2);
    span(db, "r", "a", 0, 20);
    span(db, "r", "b", 20, 40);
    const got = shares(db, "r");
    expect(got.a).toBeCloseTo(15, 6);
    expect(got.b).toBeCloseTo(15, 6);
  });

  it("counts a session from before runs in full for its own task and area", () => {
    const db = openTestDb();
    task(db, "old", "coding");
    session(db, "s", 0, 25, { task: "old", area: "coding", pausedMin: 2 });
    session(db, "plain", 30, 55);
    const rows = db
      .prepare(
        "SELECT session_id, task_id, area_id, minutes FROM v_focus_share ORDER BY session_id",
      )
      .all();
    expect(rows).toEqual([
      { session_id: "plain", task_id: null, area_id: null, minutes: 25 },
      { session_id: "s", task_id: "old", area_id: "coding", minutes: 23 },
    ]);
  });

  it("leaves out sessions still running and breaks", () => {
    const db = openTestDb();
    db.prepare(
      "INSERT INTO focus_sessions (id, kind, started_at, planned_min) VALUES ('open', 'focus', ?, 25)",
    ).run(min(0));
    db.prepare(
      "INSERT INTO focus_sessions (id, kind, started_at, planned_min, ended_at) VALUES ('br', 'break', ?, 5, ?)",
    ).run(min(0), min(5));
    expect(db.prepare("SELECT count(*) AS n FROM v_focus_share").get()).toEqual({ n: 0 });
  });

  it("sums per task for the remaining-time query", () => {
    const db = openTestDb();
    task(db, "a", null);
    task(db, "b", null);
    session(db, "old", 0, 20, { task: "a" });
    session(db, "r", 30, 50);
    lane(db, "r", "a", null, 1);
    lane(db, "r", "b", null, 2);
    span(db, "r", "a", 30, 50);
    span(db, "r", "b", 30, 50);
    const rows = db.prepare(TASK_SHARE_SQL).all() as { task_id: string; minutes: number }[];
    const byTask = Object.fromEntries(rows.map((row) => [row.task_id, row.minutes]));
    expect(byTask.a).toBeCloseTo(30, 6);
    expect(byTask.b).toBeCloseTo(10, 6);
  });
});

describe("time left on a task in a run (OPEN_TASKS_SQL)", () => {
  it("subtracts each task's share, not the whole run, and only from its own task", () => {
    const db = openTestDb();
    task(db, "a", null);
    task(db, "b", null);
    db.prepare("UPDATE task_items SET estimate_min = 30").run();
    // Before runs, focus_sessions.task_id held the first task only.
    session(db, "r", 0, 40, { task: "a" });
    lane(db, "r", "a", null, 1);
    lane(db, "r", "b", null, 2);
    span(db, "r", "a", 0, 40);
    span(db, "r", "b", 0, 20);
    const rows = db.prepare(OPEN_TASKS_SQL).all("2026-11-11") as {
      id: string;
      remaining_min: number;
    }[];
    const left = Object.fromEntries(rows.map((row) => [row.id, row.remaining_min]));
    // a: 10 + 20 = 30 of 30 → 0 (taskOnDay raises it to the floor); b: 10 of 30.
    expect(left).toEqual({ a: 0, b: 20 });
  });
});

describe("JOB_SHARE_MINUTES_SQL", () => {
  it("gives each job its shared minutes in the date range, before now", () => {
    const db = openTestDb();
    task(db, "a", "joba");
    task(db, "b", "jobb");
    task(db, "c", "coding");
    session(db, "r", 0, 60);
    lane(db, "r", "a", "joba", 1);
    lane(db, "r", "b", "jobb", 2);
    lane(db, "r", "c", "coding", 3);
    span(db, "r", "a", 0, 60);
    span(db, "r", "b", 0, 30);
    // A session from before runs, on Job A.
    session(db, "old", 70, 95, { task: "a", area: "joba" });
    // Yesterday's: outside the range.
    session(db, "y", -24 * 60, -24 * 60 + 30, { area: "jobb" });
    const rows = db.prepare(JOB_SHARE_MINUTES_SQL).all("2026-11-11", "2026-11-11", Date.now());
    // a: 30 + 15 + 25; b: 15; coding is not a job.
    expect(rows).toEqual([
      { area_id: "joba", name: "Job A", minutes: 70 },
      { area_id: "jobb", name: "Job B", minutes: 15 },
    ]);
  });
});
