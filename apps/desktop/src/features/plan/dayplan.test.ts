import { type DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { type Op, type Row, type SqlValue } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  ensureDayPlan,
  healPlans,
  isoWeekday,
  loadPlanInput,
  memoQuery,
  type OpenTaskRow,
  replanAround,
  replanDay,
  replanFromToday,
  replanUndoOps,
  savedDays,
  type SavedRow,
  startingNow,
  taskOnDay,
  weekStart,
} from "./dayplan";
import { deleteOps } from "./edit";
import { loadPreview } from "./preview";
import { DEFAULT_ANSWERS } from "./routine";
import { setupOps } from "./setup";

const NOW = Date.parse("2026-11-11T12:00:00+03:00"); // Wednesday
/** Late on the same day: today has no free time left, so a later day gets the tasks. */
const LATE = Date.parse("2026-11-11T23:30:00+03:00");

/** Applies ops the way Rust does, enough for these tests (inserts and upserts). */
function apply(db: DatabaseSync, ops: Op[]) {
  for (const op of ops) {
    if (op.op === "delete") {
      // The top 3 has no deleted_at: Rust removes its rows.
      if (op.table === "task_daily_top")
        db.prepare("DELETE FROM task_daily_top WHERE id = ?").run(op.id);
      else db.prepare(`UPDATE ${op.table} SET deleted_at = 1 WHERE id = ?`).run(op.id);
      continue;
    }
    const idColumn = op.table === "core_settings" ? "key" : "id";
    const values: Record<string, SqlValue> = { ...op.values };
    const exists = db.prepare(`SELECT 1 FROM ${op.table} WHERE ${idColumn} = ?`).get(op.id);
    // An upsert revives a soft-deleted row (tx.rs).
    if (op.op === "upsert" && exists && op.table === "day_blocks") values.deleted_at = null;
    if (op.op === "update" || (op.op === "upsert" && exists)) {
      const sets = Object.keys(values)
        .map((key) => `${key} = ?`)
        .join(", ");
      db.prepare(`UPDATE ${op.table} SET ${sets} WHERE ${idColumn} = ?`).run(
        ...(Object.values(values) as never[]),
        op.id,
      );
      continue;
    }
    const stamps =
      op.table === "core_settings" ? { updated_at: 0 } : { created_at: 0, updated_at: 0 };
    const all = { [idColumn]: op.id, ...values, ...stamps };
    const keys = Object.keys(all);
    db.prepare(
      `INSERT INTO ${op.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ).run(...(Object.values(all) as never[]));
  }
}

function harness() {
  const db = openTestDb();
  const query = <T extends Row>(sql: string, params: SqlValue[] = []) =>
    Promise.resolve(db.prepare(sql).all(...(params as never[])) as T[]);
  let n = 0;
  const newId = () => `id${++n}`;
  return { db, query, newId, transact: (ops: Op[]) => Promise.resolve(apply(db, ops)) };
}

describe("dates", () => {
  it("knows ISO weekdays and week starts", () => {
    expect(isoWeekday("2026-11-11")).toBe(3);
    expect(isoWeekday("2026-11-15")).toBe(7);
    expect(weekStart("2026-11-11")).toBe("2026-11-09");
    expect(weekStart("2026-11-09")).toBe("2026-11-09");
  });
});

describe("ensureDayPlan", () => {
  it("does nothing before setup has made a routine", async () => {
    const h = harness();
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(false);
  });

  it("generates today's blocks once from the routine", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, area_id, due_date, created_at, updated_at) VALUES ('cv', 'Update CV', 'todo', 'jobhunt', '2026-11-12', 0, 0)",
      )
      .run();

    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(false);

    const blocks = h.db
      .prepare(
        "SELECT kind, title, area_id, task_id FROM day_blocks WHERE logical_date = '2026-11-11' ORDER BY start_at",
      )
      .all();
    expect(blocks.map((b) => b.title)).toContain("Job A");
    expect(blocks.find((b) => b.kind === "area")).toMatchObject({
      area_id: "jobhunt",
      task_id: "cv",
    });
    const top = h.db
      .prepare("SELECT task_id, chosen_by FROM task_daily_top WHERE logical_date = '2026-11-11'")
      .all();
    expect(top).toEqual([{ task_id: "cv", chosen_by: "default" }]);
  });

  it("plans no away day, and plans again once you are back (F48, plan §3.11)", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    // `away till mon` on Wednesday 11 Nov: back on Monday 16.
    h.db
      .prepare(
        "INSERT INTO core_settings (key, value_json, updated_at) VALUES ('away.until', '\"2026-11-16\"', 0)",
      )
      .run();
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(false);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId, "2026-11-13")).toBe(false);
    expect(h.db.prepare("SELECT count(*) AS n FROM day_blocks").get()).toEqual({ n: 0 });
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId, "2026-11-16")).toBe(true);
  });

  it("plans once even when asked twice at the same time", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps({ ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} }, [], [], h.newId),
    );
    const results = await Promise.all([
      ensureDayPlan(h.query, h.transact, NOW, h.newId),
      ensureDayPlan(h.query, h.transact, NOW, h.newId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const titles = h.db.prepare("SELECT title FROM day_blocks WHERE title = 'Job A'").all();
    expect(titles).toHaveLength(1);
  });

  it("the database refuses the same block twice", () => {
    const h = harness();
    const insert = () =>
      h.db
        .prepare(
          "INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, created_at, updated_at) VALUES (?, '2026-11-11', 0, 1, 'fixed', 'Job A', 0, 0)",
        )
        .run(h.newId());
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });

  it("reads the rest day from setup", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, restDay: 3, clockStyle: "western", targetsHours: {} },
        [],
        [],
        h.newId,
      ),
    );
    const input = await loadPlanInput(h.query, "2026-11-11");
    expect(input.isRestDay).toBe(true);
  });

  it("follows the routine when the rest block moves in My week", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, restDay: 3, clockStyle: "western", targetsHours: {} },
        [],
        [],
        h.newId,
      ),
    );
    // Remove Wednesday's rest block by hand: the old answer no longer decides.
    h.db
      .prepare("UPDATE routine_blocks SET deleted_at = 1 WHERE weekday = 3 AND kind = 'rest'")
      .run();
    expect((await loadPlanInput(h.query, "2026-11-11")).isRestDay).toBe(false);
  });

  it("reads what is left of a task's estimate after focus time", async () => {
    const h = harness();
    h.db.exec(`INSERT INTO task_items (id, title, estimate_min, created_at, updated_at)
      VALUES ('t1', 'Report', 120, 0, 0), ('t2', 'No estimate', NULL, 0, 0);
      INSERT INTO focus_sessions (id, task_id, kind, started_at, planned_min, ended_at, paused_ms)
      VALUES ('f1', 't1', 'focus', 0, 50, 3600000, 600000)`);
    const input = await loadPlanInput(h.query, "2026-11-11");
    expect(input.tasks.map((t) => [t.id, t.remainingMin])).toEqual([
      ["t1", 70],
      ["t2", null],
    ]);
  });

  it("reads the last two nights' energy, newest first", async () => {
    const h = harness();
    h.db
      .prepare(
        `INSERT INTO day_reviews (logical_date, status, energy, created_at, updated_at) VALUES
       ('2026-11-10', 'done', 1, 0, 0),
       ('2026-11-09', 'done', 2, 0, 0),
       ('2026-11-08', 'done', 1, 0, 0),
       ('2026-11-11', 'done', 3, 0, 0)`,
      )
      .run();
    expect((await loadPlanInput(h.query, "2026-11-11")).recentEnergy).toEqual([1, 2]);
  });

  it("makes tomorrow light after two drained nights", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps({ ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} }, [], [], h.newId),
    );
    h.db
      .prepare(
        `INSERT INTO day_reviews (logical_date, status, energy, created_at, updated_at) VALUES
       ('2026-11-10', 'done', 1, 0, 0), ('2026-11-09', 'done', 1, 0, 0)`,
      )
      .run();
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    const kinds = h.db
      .prepare("SELECT DISTINCT kind FROM day_blocks WHERE logical_date = '2026-11-11'")
      .all()
      .map((row) => row.kind);
    expect(kinds).not.toContain("area");
  });

  it("makes an already planned day light when the second drained night is saved (F53)", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    h.db.exec(
      `INSERT INTO task_items (id, title, status, area_id, due_date, created_at, updated_at) VALUES
       ('a', 'A', 'todo', 'coding', '2026-11-12', 0, 0), ('b', 'B', 'todo', 'jobhunt', '2026-11-12', 1, 1),
       ('c', 'C', 'todo', 'admin', '2026-11-13', 2, 2)`,
    );
    h.db.exec(
      "INSERT INTO day_reviews (logical_date, status, energy, created_at, updated_at) VALUES ('2026-11-10', 'done', 1, 0, 0)",
    );
    // The review opened tomorrow before tonight's energy was saved.
    await ensureDayPlan(h.query, h.transact, NOW, h.newId, "2026-11-12");
    const top = () =>
      h.db.prepare("SELECT task_id FROM task_daily_top WHERE logical_date = '2026-11-12'").all();
    expect(top().length).toBeGreaterThan(1);
    h.db.exec(
      "INSERT INTO day_reviews (logical_date, status, energy, created_at, updated_at) VALUES ('2026-11-11', 'done', 1, 0, 0)",
    );
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId, "2026-11-12")).toBe(true);
    const blocks = h.db
      .prepare(
        "SELECT kind, light_day FROM day_blocks WHERE logical_date = '2026-11-12' AND deleted_at IS NULL",
      )
      .all() as { kind: string; light_day: number }[];
    expect(blocks.map((b) => b.kind)).not.toContain("area");
    expect(blocks.every((b) => b.light_day === 1)).toBe(true);
    expect(top()).toHaveLength(1);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId, "2026-11-12")).toBe(false);
  });

  it("counts this week's done minutes per area", async () => {
    const h = harness();
    h.db
      .prepare(
        `INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, status, created_at, updated_at) VALUES
       ('a', '2026-11-09', 0, 3600000, 'area', 'coding', 'x', 'done', 0, 0),
       ('b', '2026-11-10', 0, 1800000, 'area', 'coding', 'x', 'done', 0, 0),
       ('c', '2026-11-08', 0, 3600000, 'area', 'coding', 'x', 'done', 0, 0),
       ('d', '2026-11-10', 0, 3600000, 'area', 'jobhunt', 'y', 'skipped', 0, 0)`,
      )
      .run();
    const input = await loadPlanInput(h.query, "2026-11-11");
    expect(input.doneThisWeekMin).toEqual({ coding: 90 });
  });

  it("counts focus time on a block that isn't marked done, up to its length", async () => {
    const h = harness();
    h.db.exec(
      `INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, title, created_at, updated_at) VALUES
       ('q', '2026-11-10', 0, 1800000, 'area', 'quran', 'Quran', 0, 0)`,
    );
    h.db.exec(
      `INSERT INTO focus_sessions (id, block_id, kind, started_at, planned_min, paused_ms, ended_at) VALUES
       ('f1', 'q', 'focus', 0, 25, 0, 1200000), ('f2', 'q', 'focus', 0, 25, 0, 1500000)`,
    );
    const input = await loadPlanInput(h.query, "2026-11-11");
    expect(input.doneThisWeekMin).toEqual({ quran: 30 });
  });

  it("gives a running project an entry of its own for its weekly hours (F50)", async () => {
    const h = harness();
    h.db.exec(
      `INSERT INTO project_items (id, title, area_id, weekly_min, start_date, forecast_finish, status, created_at, updated_at) VALUES
       ('go', 'learn Go', 'coding', 600, '2026-11-09', '2026-11-15', 'active', 0, 0),
       ('later', 'learn Rust', 'coding', 300, '2026-11-16', '2026-11-22', 'next_up', 0, 0),
       ('idea', 'a game', 'experiments', 300, NULL, NULL, 'idea', 0, 0)`,
    );
    h.db.exec("UPDATE area_items SET active = 0 WHERE id = 'coding'");
    const areas = (await loadPlanInput(h.query, "2026-11-11")).areas;
    expect(areas.find((a) => a.id === "coding")).toMatchObject({ weeklyTargetMin: 240 });
    expect(areas.find((a) => a.id === "project:go")).toMatchObject({
      name: "learn Go",
      weeklyTargetMin: 600,
      areaId: "coding",
      projectId: "go",
      active: true,
    });
    expect(areas.some((a) => a.projectId === "idea" || a.projectId === "later")).toBe(false);
    const nextWeek = (await loadPlanInput(h.query, "2026-11-17")).areas;
    expect(nextWeek.find((a) => a.id === "project:later")?.weeklyTargetMin).toBe(300);
  });

  it("plans a running project's blocks, holding its tasks (F50)", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    h.db.exec(
      `INSERT INTO project_items (id, title, area_id, weekly_min, start_date, forecast_finish, status, created_at, updated_at) VALUES
       ('go', 'learn Go', 'coding', 600, '2026-11-09', '2026-11-22', 'active', 0, 0)`,
    );
    h.db.exec(
      `INSERT INTO task_items (id, title, status, area_id, project_id, created_at, updated_at) VALUES
       ('tour', 'Go tour', 'todo', 'coding', 'go', 0, 0),
       ('page', 'Write About page', 'todo', 'coding', NULL, 1, 1)`,
    );
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, "2026-11-12");
    const rows = h.db
      .prepare(
        `SELECT title, area_id, project_id, task_id FROM day_blocks
         WHERE logical_date = '2026-11-12' AND kind = 'area' AND deleted_at IS NULL ORDER BY start_at`,
      )
      .all() as { title: string; area_id: string; project_id: string | null; task_id: string }[];
    expect(rows).toContainEqual({
      title: "learn Go: Go tour",
      area_id: "coding",
      project_id: "go",
      task_id: "tour",
    });
    // The project's task isn't put in the area's own slot too.
    expect(rows.filter((r) => r.task_id === "tour")).toHaveLength(1);
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).toEqual([]);
  });

  it("keeps a kept project block's project (F50)", async () => {
    const h = harness();
    h.db.exec(
      `INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, area_id, project_id, title, source, user_edited_at, created_at, updated_at) VALUES
       ('p', '2026-11-11', 0, 3600000, 'area', 'coding', 'go', 'learn Go: Go tour', 'generator', 5, 0, 0)`,
    );
    const input = await loadPlanInput(h.query, "2026-11-11");
    expect(input.kept).toEqual([expect.objectContaining({ areaId: "coding", projectId: "go" })]);
  });

  it("counts focus started for an area with no block, this week only (F21)", async () => {
    const h = harness();
    const tue = Date.parse("2026-11-10T19:00:00+03:00");
    const lastWeek = Date.parse("2026-11-06T19:00:00+03:00");
    const today = Date.parse("2026-11-11T09:00:00+03:00");
    const insert = h.db.prepare(
      "INSERT INTO focus_sessions (id, area_id, kind, started_at, planned_min, paused_ms, ended_at) VALUES (?, 'experiments', 'focus', ?, 50, 0, ?)",
    );
    for (const [id, start] of [
      ["s1", tue],
      ["s2", tue + 3_600_000],
      ["s3", tue + 7_200_000],
      ["old", lastWeek],
      ["now", today],
    ] as const)
      insert.run(id, start, start + 50 * 60_000);
    const input = await loadPlanInput(h.query, "2026-11-11");
    expect(input.doneThisWeekMin).toEqual({ experiments: 150 });
  });
});

describe("replanning after a routine change", () => {
  it("rebuilds a planned day from the new routine and keeps the blocks you touched", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    // You started Quran this morning (a touched block)…
    h.db.prepare("UPDATE day_blocks SET user_edited_at = 1 WHERE title = 'Quran'").run();
    // …then moved Gym to 06:30 in My week.
    h.db.prepare("UPDATE routine_blocks SET start_min = 390 WHERE title = 'Gym'").run();
    await replanDay(h.query, h.transact, "2026-11-11", h.newId);
    const blocks = h.db
      .prepare(
        "SELECT title, start_at FROM day_blocks WHERE logical_date = '2026-11-11' AND deleted_at IS NULL ORDER BY start_at",
      )
      .all() as { title: string; start_at: number }[];
    const titles = blocks.map((b) => b.title);
    expect(titles.filter((t) => t === "Quran")).toHaveLength(1);
    expect(titles).toContain("Gym");
    const gym = blocks.find((b) => b.title === "Gym");
    // 06:30 in Addis is 03:30 UTC.
    expect(gym && new Date(gym.start_at).toISOString().slice(11, 16)).toBe("03:30");
  });

  it("reaches every planned day from today on, not just today and tomorrow (F17)", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    // Opening Fri 13 and Mon 16 in Plan → Day saved their plans.
    for (const date of ["2026-11-11", "2026-11-13", "2026-11-16"])
      await ensureDayPlan(h.query, h.transact, NOW, h.newId, date);
    h.db.prepare("UPDATE routine_blocks SET start_min = 1140 WHERE title = 'Gym'").run();
    await replanFromToday(h.query, h.transact, NOW, h.newId);
    const gyms = h.db
      .prepare(
        "SELECT logical_date, start_at FROM day_blocks WHERE title = 'Gym' AND deleted_at IS NULL ORDER BY logical_date",
      )
      .all() as { logical_date: string; start_at: number }[];
    expect(gyms.map((g) => g.logical_date)).toEqual(["2026-11-11", "2026-11-13", "2026-11-16"]);
    // 19:00 in Addis is 16:00 UTC.
    for (const gym of gyms)
      expect(new Date(gym.start_at).toISOString().slice(11, 16)).toBe("16:00");
  });

  it("leaves a day nobody planned yet alone", async () => {
    const h = harness();
    await replanDay(h.query, h.transact, "2026-11-12", h.newId);
    expect(h.db.prepare("SELECT count(*) AS n FROM day_blocks").get()).toEqual({ n: 0 });
  });

  it("treats a short Rest block as time off, not a rest day", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps({ ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} }, [], [], h.newId),
    );
    h.db
      .prepare(
        "INSERT INTO routine_blocks (id, weekday, start_min, duration_min, kind, title, created_at, updated_at) VALUES ('off', 3, 840, 240, 'rest', 'Afternoon off', 0, 0)",
      )
      .run();
    expect((await loadPlanInput(h.query, "2026-11-11")).isRestDay).toBe(false);
  });
});

describe("time first: tasks with a time or a part of the day", () => {
  const row = (over: Partial<OpenTaskRow>): OpenTaskRow => ({
    id: "t",
    title: "Call bank",
    area_id: null,
    due_date: null,
    due_at: null,
    planned_window: null,
    planned_date: null,
    estimate_min: null,
    created_at: 0,
    remaining_min: null,
    ...over,
  });
  const at = (iso: string) => Date.parse(iso);

  it("reads a task's time as a minute of its day, and leaves it out of other days", () => {
    const timed = row({ due_at: at("2026-11-11T15:00:00+03:00"), due_date: "2026-11-11" });
    expect(taskOnDay(timed, "2026-11-11")?.atMin).toBe(15 * 60);
    expect(taskOnDay(timed, "2026-11-10")).toBeUndefined();
    // A time already gone: planned like any other task.
    expect(taskOnDay(timed, "2026-11-12")?.atMin).toBeUndefined();
    // 01:00 belongs to the day before (the day starts at 03:00).
    const late = row({ due_at: at("2026-11-12T01:00:00+03:00") });
    expect(taskOnDay(late, "2026-11-11")?.atMin).toBe(25 * 60);
    // Moved to today from another day: the old time no longer holds.
    const moved = row({ due_at: at("2026-11-12T10:00:00+03:00"), planned_date: "2026-11-11" });
    expect(taskOnDay(moved, "2026-11-11")).toMatchObject({ id: "t" });
    expect(taskOnDay(moved, "2026-11-11")?.atMin).toBeUndefined();
  });

  it("keeps a time still to come off later days (reg1-3)", () => {
    const timed = row({ due_at: at("2026-11-11T18:30:00+03:00"), due_date: "2026-11-11" });
    expect(taskOnDay(timed, "2026-11-13", at("2026-11-11T08:00:00+03:00"))).toBeUndefined();
    // Once its time is gone and it isn't done, it is an ordinary task.
    expect(taskOnDay(timed, "2026-11-13", at("2026-11-11T19:30:00+03:00"))).toMatchObject({
      id: "t",
    });
  });

  it("reads a part of the day for its own day only", () => {
    const evening = row({ planned_window: "evening", planned_date: "2026-11-12" });
    expect(taskOnDay(evening, "2026-11-12")?.window).toBe("evening");
    expect(taskOnDay(evening, "2026-11-11")).toBeUndefined();
    expect(taskOnDay(evening, "2026-11-13")?.window).toBeUndefined();
  });

  it("saves a timed task as its own block on any date it is asked to plan", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, due_date, due_at, estimate_min, created_at, updated_at) VALUES ('bank', 'Call bank', 'todo', '2026-11-13', ?, 45, 0, 0)",
      )
      .run(at("2026-11-13T15:00:00+03:00"));
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, created_at, updated_at) VALUES ('milk', 'Buy milk', 'todo', 0, 0)",
      )
      .run();
    // Today is the 11th; Plan → Day asks for the 13th.
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId, "2026-11-13")).toBe(true);
    const blocks = h.db
      .prepare(
        "SELECT logical_date, start_at, end_at, kind, area_id, task_id, title, source FROM day_blocks WHERE task_id IS NOT NULL",
      )
      .all();
    expect(blocks).toEqual([
      {
        logical_date: "2026-11-13",
        start_at: at("2026-11-13T15:00:00+03:00"),
        end_at: at("2026-11-13T15:45:00+03:00"),
        kind: "area",
        area_id: null,
        task_id: "bank",
        title: "Call bank",
        source: "generator",
      },
    ]);
    // Today has no plan yet: only the asked date was planned.
    expect(
      h.db.prepare("SELECT count(*) AS n FROM day_blocks WHERE logical_date = '2026-11-11'").get(),
    ).toEqual({ n: 0 });
  });

  it("keeps a task block you moved when the day is planned again", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps({ ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} }, [], [], h.newId),
    );
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, due_at, created_at, updated_at) VALUES ('bank', 'Call bank', 'todo', ?, 0, 0)",
      )
      .run(at("2026-11-11T15:00:00+03:00"));
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    h.db
      .prepare(
        "UPDATE day_blocks SET start_at = ?, end_at = ?, user_edited_at = 1 WHERE task_id = 'bank'",
      )
      .run(at("2026-11-11T16:00:00+03:00"), at("2026-11-11T16:30:00+03:00"));
    await replanDay(h.query, h.transact, "2026-11-11", h.newId);
    const blocks = h.db
      .prepare("SELECT start_at FROM day_blocks WHERE task_id = 'bank' AND deleted_at IS NULL")
      .all();
    expect(blocks).toEqual([{ start_at: at("2026-11-11T16:00:00+03:00") }]);
  });
  it("fills today's part of the day from now on, and other days from their start", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps({ ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} }, [], [], h.newId),
    );
    const input = await loadPlanInput(h.query, "2026-11-11");
    // NOW is 12:00 on the 11th.
    expect(startingNow(input, NOW).notBeforeMin).toBe(12 * 60);
    // 01:30 on the 12th still belongs to the 11th.
    expect(startingNow(input, Date.parse("2026-11-12T01:30:00+03:00")).notBeforeMin).toBe(
      25 * 60 + 30,
    );
    expect(startingNow({ ...input, date: "2026-11-12" }, NOW).notBeforeMin).toBeUndefined();
  });

  it("doesn't make again a task block you touched and then deleted", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps({ ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} }, [], [], h.newId),
    );
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, due_at, created_at, updated_at) VALUES ('bank', 'Call bank', 'todo', ?, 0, 0)",
      )
      .run(at("2026-11-11T15:00:00+03:00"));
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    h.db
      .prepare("UPDATE day_blocks SET user_edited_at = 1, deleted_at = 2 WHERE task_id = 'bank'")
      .run();
    await replanDay(h.query, h.transact, "2026-11-11", h.newId, NOW);
    expect(
      h.db
        .prepare(
          "SELECT count(*) AS n FROM day_blocks WHERE task_id = 'bank' AND deleted_at IS NULL",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
});

describe("a planned day heals itself (time first §1 rule 1)", () => {
  const at = (iso: string) => Date.parse(iso);
  const DAY = "2026-11-11";

  function planned() {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    return h;
  }
  /** What tx.rs does for the user: an update stamps user_edited_at; a delete is soft. */
  function asUser(db: DatabaseSync, ops: Op[]) {
    for (const op of ops) {
      if (op.op === "delete") {
        db.prepare(`UPDATE ${op.table} SET deleted_at = 2 WHERE id = ?`).run(op.id);
      } else if (op.op === "update") {
        const names = Object.keys(op.values);
        db.prepare(
          `UPDATE ${op.table} SET ${[...names.map((n) => `${n} = ?`), "user_edited_at = 1"].join(", ")} WHERE id = ?`,
        ).run(...(Object.values(op.values) as never[]), op.id);
      } else throw new Error("only updates and deletes here");
    }
  }
  const addTask = (h: ReturnType<typeof harness>, id: string, title: string, dueAt: number) =>
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, due_at, due_date, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?, 5, 5)",
      )
      .run(id, title, dueAt, DAY);
  const blocksOf = (h: ReturnType<typeof harness>, taskId: string) =>
    h.db
      .prepare(
        "SELECT id, start_at FROM day_blocks WHERE task_id = ? AND deleted_at IS NULL ORDER BY start_at",
      )
      .all(taskId);

  it("gives a task captured after the day was planned its block, once", async () => {
    const h = planned();
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    // "call bank today 3pm", typed at noon after the day was planned.
    addTask(h, "bank", "Call bank", at("2026-11-11T15:00:00+03:00"));
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(blocksOf(h, "bank")).toEqual([
      { id: expect.any(String), start_at: at("2026-11-11T15:00:00+03:00") },
    ]);
    // Nothing to heal the second time: no write.
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(false);
  });

  it("moves the block when the task's time changes", async () => {
    const h = planned();
    addTask(h, "bank", "Call bank", at("2026-11-11T15:00:00+03:00"));
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    h.db
      .prepare("UPDATE task_items SET due_at = ? WHERE id = 'bank'")
      .run(at("2026-11-11T17:00:00+03:00"));
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(blocksOf(h, "bank")).toEqual([
      { id: expect.any(String), start_at: at("2026-11-11T17:00:00+03:00") },
    ]);
  });

  it("keeps the blocks you edited while it heals", async () => {
    const h = planned();
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    const jobA = h.db
      .prepare(
        `SELECT id, start_at FROM day_blocks WHERE title = 'Job A' AND logical_date = '${DAY}'`,
      )
      .get() as { id: string; start_at: number };
    asUser(h.db, [
      { op: "update", table: "day_blocks", id: jobA.id, values: { title: "Job A (office)" } },
    ]);
    addTask(h, "bank", "Call bank", at("2026-11-11T15:00:00+03:00"));
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    expect(
      h.db.prepare("SELECT title, deleted_at FROM day_blocks WHERE id = ?").get(jobA.id),
    ).toEqual({ title: "Job A (office)", deleted_at: null });
    expect(blocksOf(h, "bank")).toHaveLength(1);
  });

  it("places a task given a part of the day after planning", async () => {
    const h = planned();
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, planned_window, due_date, created_at, updated_at) VALUES ('book', 'Read a book', 'todo', 'evening', ?, 5, 5)",
      )
      .run(DAY);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    const [block] = blocksOf(h, "book") as { start_at: number }[];
    expect(block?.start_at).toBeGreaterThanOrEqual(at("2026-11-11T17:00:00+03:00"));
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(false);
  });

  it("heals later planned days too (Next 7 days, a capture with the window open)", async () => {
    const h = planned();
    await ensureDayPlan(h.query, h.transact, NOW, h.newId, "2026-11-13");
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, due_at, due_date, created_at, updated_at) VALUES ('dentist', 'Dentist', 'todo', ?, '2026-11-13', 5, 5)",
      )
      .run(at("2026-11-13T10:00:00+03:00"));
    expect(await healPlans(h.query, h.transact, NOW, h.newId)).toEqual(["2026-11-13"]);
    expect(blocksOf(h, "dentist")).toHaveLength(1);
    expect(await healPlans(h.query, h.transact, NOW, h.newId)).toEqual([]);
  });

  it("leaves a day already gone as it was", async () => {
    const h = planned();
    await ensureDayPlan(h.query, h.transact, NOW, h.newId, "2026-11-11");
    addTask(h, "bank", "Call bank", at("2026-11-11T15:00:00+03:00"));
    const nextDay = at("2026-11-12T12:00:00+03:00");
    expect(await ensureDayPlan(h.query, h.transact, nextDay, h.newId, DAY)).toBe(false);
    expect(blocksOf(h, "bank")).toEqual([]);
  });

  it("keeps the block a focus session runs in while it heals", async () => {
    const h = planned();
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    const area = h.db
      .prepare(
        `SELECT id, start_at, end_at FROM day_blocks WHERE logical_date = '${DAY}' AND kind = 'area' AND task_id IS NULL AND deleted_at IS NULL ORDER BY start_at LIMIT 1`,
      )
      .get() as { id: string; start_at: number; end_at: number } | undefined;
    if (!area) throw new Error("expected an area block");
    h.db
      .prepare(
        "INSERT INTO focus_sessions (id, block_id, kind, started_at, planned_min, paused_ms) VALUES ('s1', ?, 'focus', ?, 25, 0)",
      )
      .run(area.id, area.start_at);
    addTask(h, "bank", "Call bank", at("2026-11-11T15:00:00+03:00"));
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(h.db.prepare("SELECT deleted_at FROM day_blocks WHERE id = ?").get(area.id)).toEqual({
      deleted_at: null,
    });
    // ...and plans around it: no second block over its time.
    expect(
      h.db
        .prepare(
          `SELECT count(*) AS n FROM day_blocks WHERE logical_date = '${DAY}' AND deleted_at IS NULL AND id != ? AND start_at < ? AND end_at > ? AND kind = 'area'`,
        )
        .get(area.id, area.end_at, area.start_at),
    ).toEqual({ n: 0 });
  });

  it("doesn't bring back a block you deleted on the board", async () => {
    const h = planned();
    addTask(h, "bank", "Call bank", at("2026-11-11T15:00:00+03:00"));
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    const [own] = blocksOf(h, "bank") as { id: string }[];
    if (!own) throw new Error("expected the task's block");
    const area = h.db
      .prepare(
        `SELECT id, start_at, end_at, title FROM day_blocks WHERE logical_date = '${DAY}' AND kind = 'area' AND task_id IS NULL AND deleted_at IS NULL ORDER BY start_at LIMIT 1`,
      )
      .get() as { id: string; start_at: number; end_at: number; title: string } | undefined;
    if (!area) throw new Error("expected an area block");
    asUser(h.db, deleteOps(own));
    asUser(h.db, deleteOps(area));
    // A new capture makes the day heal (or Plan → Day replans it): neither comes back.
    addTask(h, "rent", "Pay rent", at("2026-11-11T19:00:00+03:00"));
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(blocksOf(h, "bank")).toEqual([]);
    expect(blocksOf(h, "rent")).toHaveLength(1);
    const overlapping = h.db
      .prepare(
        `SELECT count(*) AS n FROM day_blocks WHERE logical_date = '${DAY}' AND kind = 'area' AND task_id IS NULL AND deleted_at IS NULL AND start_at < ? AND end_at > ?`,
      )
      .get(area.end_at, area.start_at);
    expect(overlapping).toEqual({ n: 0 });
  });
});

describe("review fixes: replans keep what you moved and what is over", () => {
  const at = (iso: string) => Date.parse(iso);
  const DAY = "2026-11-11";
  function planned() {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    return h;
  }
  const live = (h: ReturnType<typeof harness>, title: string) =>
    h.db
      .prepare(
        `SELECT id, start_at FROM day_blocks WHERE logical_date = '${DAY}' AND title = ? AND deleted_at IS NULL ORDER BY start_at`,
      )
      .all(title) as { id: string; start_at: number }[];

  it("doesn't bring a routine block you moved back at its old time", async () => {
    const h = planned();
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    const [quran] = live(h, "Quran");
    if (!quran) throw new Error("expected a Quran block");
    const later = quran.start_at + 2 * 3600_000;
    h.db
      .prepare("UPDATE day_blocks SET start_at = ?, end_at = ?, user_edited_at = 1 WHERE id = ?")
      .run(later, later + 20 * 60_000, quran.id);
    await replanDay(h.query, h.transact, DAY, h.newId);
    expect(live(h, "Quran")).toEqual([{ id: quran.id, start_at: later }]);
  });

  it("keeps today's blocks already over when it heals, and adds only the missing one", async () => {
    const h = planned();
    // Planned at 07:00 with a morning task; it is placed in the morning.
    const early = at("2026-11-11T07:00:00+03:00");
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, planned_window, due_date, created_at, updated_at) VALUES ('walk', 'Morning walk', 'todo', 'morning', ?, 5, 5)",
      )
      .run(DAY);
    expect(await ensureDayPlan(h.query, h.transact, early, h.newId)).toBe(true);
    const [walk] = live(h, "Morning walk");
    if (!walk) throw new Error("expected the walk's block");
    expect(walk.start_at).toBeLessThan(NOW);
    const before = h.db
      .prepare(`SELECT id FROM day_blocks WHERE logical_date = '${DAY}' AND deleted_at IS NULL`)
      .all() as { id: string }[];
    // At noon a capture with a time makes the day heal.
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, due_at, due_date, created_at, updated_at) VALUES ('bank', 'Call bank', 'todo', ?, ?, 6, 6)",
      )
      .run(at("2026-11-11T20:15:00+03:00"), DAY);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(live(h, "Morning walk")).toEqual([walk]);
    expect(live(h, "Call bank")).toHaveLength(1);
    // Nothing else changed: every block from before is still there.
    const after = new Set(
      (
        h.db
          .prepare(`SELECT id FROM day_blocks WHERE logical_date = '${DAY}' AND deleted_at IS NULL`)
          .all() as { id: string }[]
      ).map((row) => row.id),
    );
    for (const { id } of before) expect(after.has(id)).toBe(true);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(false);
  });

  it("keeps blocks already over on a full replan of today too", async () => {
    const h = planned();
    const early = at("2026-11-11T07:00:00+03:00");
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, planned_window, due_date, created_at, updated_at) VALUES ('walk', 'Morning walk', 'todo', 'morning', ?, 5, 5)",
      )
      .run(DAY);
    await ensureDayPlan(h.query, h.transact, early, h.newId);
    const [walk] = live(h, "Morning walk");
    await replanDay(h.query, h.transact, DAY, h.newId, NOW);
    expect(live(h, "Morning walk")).toEqual([walk]);
  });

  it("still moves a task's block when its time moves from the morning to later", async () => {
    const h = planned();
    const early = at("2026-11-11T07:00:00+03:00");
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, due_at, due_date, created_at, updated_at) VALUES ('bank', 'Call bank', 'todo', ?, ?, 5, 5)",
      )
      .run(at("2026-11-11T08:00:00+03:00"), DAY);
    await ensureDayPlan(h.query, h.transact, early, h.newId);
    h.db
      .prepare("UPDATE task_items SET due_at = ? WHERE id = 'bank'")
      .run(at("2026-11-11T17:00:00+03:00"));
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(live(h, "Call bank").map((b) => b.start_at)).toContain(at("2026-11-11T17:00:00+03:00"));
  });
});

describe("a planned day lets go of a task that changed (F10, F11, F13)", () => {
  const at = (iso: string) => Date.parse(iso);
  const DAY = "2026-11-11";
  const TOMORROW = "2026-11-12";
  function planned() {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    return h;
  }
  const addTimed = (h: ReturnType<typeof harness>, id: string, title: string, dueAt: number) =>
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, due_at, due_date, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?, 5, 5)",
      )
      .run(id, title, dueAt, DAY);
  const liveOf = (h: ReturnType<typeof harness>, taskId: string, date = DAY) =>
    h.db
      .prepare(
        "SELECT id, start_at, title, area_id FROM day_blocks WHERE task_id = ? AND logical_date = ? AND deleted_at IS NULL ORDER BY start_at",
      )
      .all(taskId, date) as { id: string; start_at: number; title: string; area_id: string }[];

  it("a capture takes only its own time out of a focus slot; nothing else moves (F12)", async () => {
    const h = planned();
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    const liveIds = () =>
      (
        h.db
          .prepare(`SELECT id FROM day_blocks WHERE logical_date = '${DAY}' AND deleted_at IS NULL`)
          .all() as { id: string }[]
      ).map((row) => row.id);
    const before = liveIds();
    const slot = h.db
      .prepare(
        `SELECT id, start_at, end_at, title FROM day_blocks WHERE logical_date = '${DAY}' AND kind = 'area' AND start_at > ? AND end_at - start_at >= ? AND deleted_at IS NULL ORDER BY start_at LIMIT 1`,
      )
      .get(NOW, 45 * 60_000) as { id: string; start_at: number; end_at: number; title: string };
    // "read a book" lands 25 minutes into the slot, for 30 minutes.
    const startsAt = slot.start_at + 25 * 60_000;
    addTimed(h, "book", "read a book", startsAt);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    const after = new Set(liveIds());
    for (const id of before) expect(after.has(id)).toBe(true);
    expect(
      h.db.prepare("SELECT start_at, end_at FROM day_blocks WHERE id = ?").get(slot.id),
    ).toEqual({ start_at: slot.start_at, end_at: startsAt });
    expect(liveOf(h, "book").map((b) => b.start_at)).toEqual([startsAt]);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(false);
  });

  it("drops a deleted task's block, once", async () => {
    const h = planned();
    addTimed(h, "bank", "call bank", at("2026-11-11T14:00:00+03:00"));
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    expect(liveOf(h, "bank")).toHaveLength(1);
    h.db.prepare("UPDATE task_items SET deleted_at = 9 WHERE id = 'bank'").run();
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(liveOf(h, "bank")).toEqual([]);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(false);
  });

  it("a fixed capture keeps only the new time's block", async () => {
    const h = planned();
    addTimed(h, "a", "call bank", at("2026-11-11T14:00:00+03:00"));
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    // The fix deletes the old task and saves a new one at 16:00.
    h.db.prepare("UPDATE task_items SET deleted_at = 9 WHERE id = 'a'").run();
    addTimed(h, "b", "call bank", at("2026-11-11T16:00:00+03:00"));
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(liveOf(h, "a")).toEqual([]);
    expect(liveOf(h, "b").map((b) => b.start_at)).toEqual([at("2026-11-11T16:00:00+03:00")]);
    // Undo deletes the new one too: nothing is left.
    h.db.prepare("UPDATE task_items SET deleted_at = 9 WHERE id = 'b'").run();
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(liveOf(h, "b")).toEqual([]);
  });

  it("drops the block of a task done or moved to another day", async () => {
    const h = planned();
    addTimed(h, "bank", "call bank", at("2026-11-11T14:00:00+03:00"));
    addTimed(h, "rent", "pay rent", at("2026-11-11T19:00:00+03:00"));
    await ensureDayPlan(h.query, h.transact, NOW, h.newId);
    h.db.prepare("UPDATE task_items SET status = 'done' WHERE id = 'bank'").run();
    // The editor moved it to tomorrow and the time went with the old date.
    h.db
      .prepare("UPDATE task_items SET due_at = NULL, due_date = ? WHERE id = 'rent'")
      .run(TOMORROW);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(true);
    expect(liveOf(h, "bank")).toEqual([]);
    expect(liveOf(h, "rent")).toEqual([]);
    expect(await ensureDayPlan(h.query, h.transact, NOW, h.newId)).toBe(false);
  });

  it("gives a later day's focus slot another task when its task is done", async () => {
    const h = planned();
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, area_id, due_date, created_at, updated_at) VALUES ('cv', 'Update CV', 'todo', 'jobhunt', ?, 0, 0), ('apply', 'Apply to Kifiya', 'todo', 'jobhunt', NULL, 1, 1)",
      )
      .run(TOMORROW);
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, TOMORROW);
    const [slot] = liveOf(h, "cv", TOMORROW);
    expect(slot?.title).toBe("Job hunt: Update CV");
    h.db.prepare("UPDATE task_items SET status = 'done' WHERE id = 'cv'").run();
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).toEqual([TOMORROW]);
    expect(liveOf(h, "cv", TOMORROW)).toEqual([]);
    expect(liveOf(h, "apply", TOMORROW).map((b) => b.title)).toContain("Job hunt: Apply to Kifiya");
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).toEqual([]);
  });

  it("renames a slot's task in place, and replans when it moves to another area", async () => {
    const h = planned();
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, area_id, due_date, created_at, updated_at) VALUES ('cv', 'Update CV', 'todo', 'jobhunt', ?, 0, 0)",
      )
      .run(TOMORROW);
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, TOMORROW);
    const [slot] = liveOf(h, "cv", TOMORROW);
    h.db.prepare("UPDATE task_items SET title = 'Update my CV' WHERE id = 'cv'").run();
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).toEqual([TOMORROW]);
    expect(liveOf(h, "cv", TOMORROW)).toEqual([{ ...slot, title: "Job hunt: Update my CV" }]);
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).toEqual([]);
    h.db.prepare("UPDATE task_items SET area_id = 'coding' WHERE id = 'cv'").run();
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).toEqual([TOMORROW]);
    expect(liveOf(h, "cv", TOMORROW).map((b) => b.title)).toEqual(["Coding skills: Update my CV"]);
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).toEqual([]);
  });

  it("keeps a slot when its area is renamed, and gives it the new name", async () => {
    const h = planned();
    h.db
      .prepare(
        "INSERT INTO task_items (id, title, status, area_id, due_date, created_at, updated_at) VALUES ('page', 'Write About page copy', 'todo', 'coding', ?, 0, 0)",
      )
      .run(TOMORROW);
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, TOMORROW);
    const [slot] = liveOf(h, "page", TOMORROW);
    expect(slot?.title).toBe("Coding skills: Write About page copy");
    h.db.prepare("UPDATE area_items SET name = 'Coding' WHERE id = 'coding'").run();
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).toEqual([TOMORROW]);
    expect(liveOf(h, "page", TOMORROW)).toEqual([
      { ...slot, title: "Coding: Write About page copy" },
    ]);
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).toEqual([]);
  });
});

describe("a later day is planned after the days before it (F18)", () => {
  it("doesn't book a task again that an earlier saved day already covers", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    h.db.exec(
      `INSERT INTO task_items (id, title, status, area_id, due_date, estimate_min, created_at, updated_at) VALUES
       ('a', 'Write About page', 'todo', 'coding', '2026-11-10', 60, 0, 0),
       ('b', 'Apply at Kifiya', 'todo', 'jobhunt', '2026-11-12', 45, 1, 1),
       ('c', 'Renew residence ID', 'todo', 'admin', '2026-11-13', 30, 2, 2),
       ('d', 'Case study', 'todo', 'coding', '2026-11-14', 120, 3, 3)`,
    );
    for (const date of ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"])
      await ensureDayPlan(h.query, h.transact, NOW, h.newId, date);
    const rows = h.db
      .prepare(
        `SELECT logical_date, task_id, (end_at - start_at) / 60000 AS minutes FROM day_blocks
         WHERE task_id IS NOT NULL AND deleted_at IS NULL AND end_at > ? ORDER BY start_at`,
      )
      .all(NOW) as { logical_date: string; task_id: string; minutes: number }[];
    const estimate: Record<string, number> = { a: 60, b: 45, c: 30, d: 120 };
    const booked = new Map<string, number>();
    for (const row of rows) {
      // A later day only gives a task time the days before it didn't.
      expect(booked.get(row.task_id) ?? 0).toBeLessThan(estimate[row.task_id] ?? 0);
      booked.set(row.task_id, (booked.get(row.task_id) ?? 0) + row.minutes);
    }
    // Every task gets its time somewhere in these days.
    expect([...booked.keys()].sort()).toEqual(["a", "b", "c", "d"]);
    expect(await healPlans(h.query, h.transact, NOW, h.newId)).toEqual([]);
  });

  it("doesn't book an overdue task again on the next day opened", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    h.db.exec(
      `INSERT INTO task_items (id, title, status, area_id, due_date, estimate_min, created_at, updated_at) VALUES
       ('a', 'Write About page', 'todo', 'coding', '2026-11-10', 60, 0, 0)`,
    );
    const taskDays = () =>
      (
        h.db
          .prepare(
            "SELECT logical_date FROM day_blocks WHERE task_id = 'a' AND deleted_at IS NULL AND end_at > ?",
          )
          .all(LATE) as { logical_date: string }[]
      ).map((row) => row.logical_date);
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, "2026-11-12");
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, "2026-11-13");
    expect(taskDays()).toEqual(["2026-11-12"]);
  });
});

describe("an opened day holds what the forecast said (F18, reg1-1, reg1-2)", () => {
  const MORNING = Date.parse("2026-11-11T08:00:00+03:00");
  function week() {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    h.db.exec(
      `INSERT INTO task_items (id, title, status, area_id, due_date, estimate_min, created_at, updated_at) VALUES
       ('a', 'Write About page', 'todo', 'coding', '2026-11-10', 60, 0, 0),
       ('b', 'Apply at Kifiya', 'todo', 'jobhunt', '2026-11-12', 45, 1, 1),
       ('c', 'Renew residence ID', 'todo', 'admin', '2026-11-13', 60, 2, 2),
       ('d', 'Case study', 'todo', 'coding', '2026-11-14', 120, 3, 3)`,
    );
    return h;
  }
  const dayShape = (h: ReturnType<typeof harness>, date: string) =>
    (
      h.db
        .prepare(
          `SELECT start_at, end_at, title, task_id FROM day_blocks
           WHERE logical_date = ? AND deleted_at IS NULL ORDER BY start_at`,
        )
        .all(date) as { start_at: number; end_at: number; title: string; task_id: string }[]
    ).map((b) => `${b.start_at}-${b.end_at} ${b.title}`);

  it("plans a day the same whichever day you open first", async () => {
    const one = week();
    const two = week();
    // Today's plan was made early this morning; it is now 08:00.
    await ensureDayPlan(one.query, one.transact, MORNING - 3 * 3600_000, one.newId);
    await ensureDayPlan(two.query, two.transact, MORNING - 3 * 3600_000, two.newId);
    await ensureDayPlan(one.query, one.transact, MORNING, one.newId, "2026-11-13");
    await ensureDayPlan(one.query, one.transact, MORNING, one.newId, "2026-11-12");
    await ensureDayPlan(two.query, two.transact, MORNING, two.newId, "2026-11-12");
    await ensureDayPlan(two.query, two.transact, MORNING, two.newId, "2026-11-13");
    expect(dayShape(one, "2026-11-13")).toEqual(dayShape(two, "2026-11-13"));
    expect(dayShape(one, "2026-11-12")).toEqual(dayShape(two, "2026-11-12"));
    // A later day gives a task time only when the days before didn't cover it.
    const rows = one.db
      .prepare(
        `SELECT task_id, (end_at - start_at) / 60000 AS minutes FROM day_blocks
         WHERE task_id IS NOT NULL AND deleted_at IS NULL AND end_at > ? ORDER BY start_at`,
      )
      .all(MORNING) as { task_id: string; minutes: number }[];
    const estimate: Record<string, number> = { a: 60, b: 45, c: 60, d: 120 };
    const got = new Map<string, number>();
    for (const row of rows) {
      expect(got.get(row.task_id) ?? 0).toBeLessThan(estimate[row.task_id] ?? 0);
      got.set(row.task_id, (got.get(row.task_id) ?? 0) + row.minutes);
    }
  });

  it("opens each day as Next 7 days showed it", async () => {
    const h = week();
    await ensureDayPlan(h.query, h.transact, MORNING - 3 * 3600_000, h.newId);
    const forecast = await loadPreview(h.query, "2026-11-11", MORNING);
    for (const date of ["2026-11-14", "2026-11-12", "2026-11-13"]) {
      await ensureDayPlan(h.query, h.transact, MORNING, h.newId, date);
      const shown = forecast.days.find((day) => day.date === date)?.blocks ?? [];
      const focus = (
        h.db
          .prepare(
            `SELECT start_at, end_at, title FROM day_blocks
             WHERE logical_date = ? AND kind = 'area' AND deleted_at IS NULL ORDER BY start_at`,
          )
          .all(date) as { start_at: number; end_at: number; title: string }[]
      ).map((b) => b.title);
      expect(focus).toEqual(shown.map((b) => b.title));
    }
    // The forecast doesn't change when the days are opened.
    expect((await loadPreview(h.query, "2026-11-11", MORNING)).days).toEqual(forecast.days);
  });

  it("doesn't count a block missed earlier today as time the task got", () => {
    const day = "2026-11-11";
    const block = (start: string, end: string, over: Partial<SavedRow> = {}): SavedRow => ({
      logical_date: day,
      start_at: Date.parse(`${day}T${start}:00+03:00`),
      end_at: Date.parse(`${day}T${end}:00+03:00`),
      kind: "area",
      area_id: "coding",
      task_id: "a",
      title: "Coding: Write About page",
      light_day: 0,
      status: "planned",
      focused: 0,
      ...over,
    });
    const saved = savedDays(
      [
        block("06:30", "07:45"),
        block("17:15", "18:00", { task_id: "b", title: "Job hunt: Apply" }),
        block("18:00", "18:30", { task_id: "c", status: "done" }),
      ],
      MORNING,
    ).get(day);
    expect(saved?.booked).toEqual([{ areaId: "coding", taskId: "b", durationMin: 45 }]);
    expect(saved?.blocks.map((b) => b.title)).toEqual(["Job hunt: Apply"]);
  });
});

describe("a block moved by a command onto a planner block (F15)", () => {
  const TOMORROW = "2026-11-12";
  type Live = {
    id: string;
    start_at: number;
    end_at: number;
    title: string;
    kind: string;
    untouched: number;
  };
  const liveBlocks = (h: ReturnType<typeof harness>) =>
    h.db
      .prepare(
        `SELECT id, start_at, end_at, title, kind,
           (source IN ('template', 'generator') AND user_edited_at IS NULL) AS untouched
         FROM day_blocks WHERE logical_date = ? AND deleted_at IS NULL ORDER BY start_at`,
      )
      .all(TOMORROW) as Live[];

  it("plans the untouched blocks again around it, and undo puts them back", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "quran", "quran", "admin"],
        h.newId,
      ),
    );
    h.db.exec(
      "INSERT INTO task_items (id, title, status, area_id, due_date, created_at, updated_at) VALUES ('k', 'Apply at Kifiya', 'todo', 'jobhunt', '2026-11-12', 0, 0)",
    );
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, TOMORROW);
    const before = liveBlocks(h);
    const quran = before.find((b) => b.title === "Quran");
    const slot = before.find((b) => b.title.startsWith("Job hunt") && b.untouched === 1);
    if (!quran || !slot) throw new Error("expected Quran and a Job hunt slot");
    // "move quran to …": it now starts 15 minutes before the slot ends (tx.rs stamps the edit).
    const length = quran.end_at - quran.start_at;
    const start = slot.end_at - 15 * 60_000;
    h.db
      .prepare("UPDATE day_blocks SET start_at = ?, end_at = ?, user_edited_at = 5 WHERE id = ?")
      .run(start, start + length, quran.id);
    const undo = await replanAround(h.query, h.transact, TOMORROW, quran.id, h.newId, LATE);
    expect(undo).not.toBeNull();
    const after = liveBlocks(h);
    const clash = after.filter(
      (b) => b.untouched === 1 && b.start_at < start + length && start < b.end_at,
    );
    expect(clash).toEqual([]);
    // The task still gets its time somewhere.
    expect(after.some((b) => b.title === "Job hunt: Apply at Kifiya")).toBe(true);
    // Nothing in the way: nothing to do.
    expect(await replanAround(h.query, h.transact, TOMORROW, quran.id, h.newId, LATE)).toBeNull();
    apply(h.db, undo ?? []);
    h.db
      .prepare("UPDATE day_blocks SET start_at = ?, end_at = ? WHERE id = ?")
      .run(quran.start_at, quran.end_at, quran.id);
    const shape = (rows: Live[]) => rows.map((b) => [b.start_at, b.end_at, b.title]);
    expect(shape(liveBlocks(h))).toEqual(shape(before));
  });

  it("undo keeps a moved block you moved again since", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "quran", "quran", "admin"],
        h.newId,
      ),
    );
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, TOMORROW);
    const before = liveBlocks(h);
    const quran = before.find((b) => b.title === "Quran");
    const slot = before.find((b) => b.kind === "area" && b.untouched === 1);
    if (!quran || !slot) throw new Error("expected Quran and a focus slot");
    const start = slot.end_at - 15 * 60_000;
    h.db
      .prepare("UPDATE day_blocks SET start_at = ?, end_at = ?, user_edited_at = 5 WHERE id = ?")
      .run(start, start + (quran.end_at - quran.start_at), quran.id);
    const undo = (await replanAround(h.query, h.transact, TOMORROW, quran.id, h.newId, LATE)) ?? [];
    expect(undo.map((op) => op.id)).toContain(slot.id);
    // A later command moved the block that made room: it is yours now.
    h.db.prepare("UPDATE day_blocks SET user_edited_at = 6 WHERE id = ?").run(slot.id);
    const now = await replanUndoOps(h.query, undo);
    expect(now.some((op) => op.id === slot.id)).toBe(false);
    expect(now).toHaveLength(undo.length - 1);
  });

  it("moves only the block in the way, into free time later (reg1-4)", async () => {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    h.db.exec(
      `INSERT INTO task_items (id, title, status, area_id, due_date, estimate_min, created_at, updated_at) VALUES
       ('a', 'Write About page', 'todo', 'coding', '2026-11-10', 60, 0, 0),
       ('k', 'Apply at Kifiya', 'todo', 'jobhunt', '2026-11-12', 45, 1, 1)`,
    );
    const WED = "2026-11-18";
    const at = (time: string) => Date.parse(`${WED}T${time}:00+03:00`);
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, WED);
    const rows = () =>
      h.db
        .prepare(
          `SELECT id, start_at, end_at, title FROM day_blocks
           WHERE logical_date = ? AND deleted_at IS NULL ORDER BY start_at`,
        )
        .all(WED) as { id: string; start_at: number; end_at: number; title: string }[];
    const before = rows();
    const gym = before.find((b) => b.title === "Gym");
    const evening = before.find((b) => b.start_at === at("18:30"));
    if (!gym || !evening) throw new Error("expected Gym and an evening focus block");
    // "move gym to 6pm"
    h.db
      .prepare("UPDATE day_blocks SET start_at = ?, end_at = ?, user_edited_at = 5 WHERE id = ?")
      .run(at("18:00"), at("18:45"), gym.id);
    const undo = await replanAround(h.query, h.transact, WED, gym.id, h.newId, LATE);
    const after = rows();
    // The evening block keeps its task and length, from the end of Gym.
    expect(after.find((b) => b.id === evening.id)).toEqual({
      ...evening,
      start_at: at("18:45"),
      end_at: at("18:45") + (evening.end_at - evening.start_at),
    });
    // Nothing else moved.
    const others = (list: typeof before) =>
      list.filter((b) => b.id !== evening.id && b.id !== gym.id);
    expect(others(after)).toEqual(others(before));
    apply(h.db, undo ?? []);
    expect(rows().find((b) => b.id === evening.id)).toEqual(evening);
  });

  /** Wed planned with a timed task, "move gym to 6pm" applied (reg1-4). */
  async function gymOnTimedTask() {
    const h = harness();
    apply(
      h.db,
      setupOps(
        { ...DEFAULT_ANSWERS, clockStyle: "western", targetsHours: {} },
        [],
        ["joba", "jobb", "jobhunt", "coding", "experiments", "gym", "quran", "admin"],
        h.newId,
      ),
    );
    const WED = "2026-11-18";
    const at = (time: string) => Date.parse(`${WED}T${time}:00+03:00`);
    h.db
      .prepare(
        `INSERT INTO task_items (id, title, status, area_id, due_date, due_at, estimate_min, created_at, updated_at)
         VALUES ('bank', 'Call bank', 'todo', 'admin', ?, ?, 30, 0, 0)`,
      )
      .run(WED, at("18:00"));
    await ensureDayPlan(h.query, h.transact, LATE, h.newId, WED);
    const rows = () =>
      h.db
        .prepare(
          `SELECT id, start_at, end_at, title FROM day_blocks
           WHERE logical_date = ? AND deleted_at IS NULL ORDER BY start_at`,
        )
        .all(WED) as { id: string; start_at: number; end_at: number; title: string }[];
    const before = rows();
    const gym = before.find((b) => b.title === "Gym");
    const bank = before.find((b) => b.title === "Call bank");
    if (!gym || !bank) throw new Error("expected Gym and Call bank");
    expect(bank.start_at).toBe(at("18:00"));
    h.db
      .prepare("UPDATE day_blocks SET start_at = ?, end_at = ?, user_edited_at = 5 WHERE id = ?")
      .run(at("18:00"), at("18:45"), gym.id);
    const undo = (await replanAround(h.query, h.transact, WED, gym.id, h.newId, LATE)) ?? [];
    return { h, WED, at, rows, bank, undo };
  }

  it("leaves a timed task's own block at its time (reg1-4)", async () => {
    const { h, WED, rows, bank, undo } = await gymOnTimedTask();
    expect(rows().find((b) => b.id === bank.id)).toEqual(bank);
    expect(undo.some((op) => op.id === bank.id)).toBe(false);
    // Nothing for a heal to fix afterwards.
    expect(await healPlans(h.query, h.transact, LATE, h.newId)).not.toContain(WED);
  });

  it("undo leaves out a moved block deleted since (reg1-4)", async () => {
    const { h, rows, undo } = await gymOnTimedTask();
    const moved = undo.find((op) => op.op === "upsert");
    if (!moved || moved.op !== "upsert") throw new Error("expected a block that made room");
    const block = rows().find((b) => b.id === moved.id);
    if (!block) throw new Error("expected the moved block");
    // A heal deleted it and made a fresh block at its old time.
    const v = moved.values;
    h.db.prepare("UPDATE day_blocks SET deleted_at = 9 WHERE id = ?").run(moved.id);
    h.db
      .prepare(
        `INSERT INTO day_blocks (id, logical_date, start_at, end_at, kind, title, source, created_at, updated_at)
         VALUES ('fresh', ?, ?, ?, 'area', ?, 'generator', 0, 0)`,
      )
      .run(...([v.logical_date, v.start_at, v.end_at, v.title] as never[]));
    const now = await replanUndoOps(h.query, undo);
    expect(now.some((op) => op.id === moved.id)).toBe(false);
    expect(() => apply(h.db, now)).not.toThrow();
  });
});

describe("memoQuery", () => {
  it("reads each query once until a write clears it", async () => {
    let reads = 0;
    const memo = memoQuery(<T extends Row>() => {
      reads += 1;
      return Promise.resolve([{ n: reads }] as unknown as T[]);
    });
    const first = await memo.query<{ n: number }>("SELECT ?", [1]);
    const [row] = first;
    if (row) row.n = 99;
    expect(await memo.query("SELECT ?", [1])).toEqual([{ n: 1 }]);
    expect(await memo.query("SELECT ?", [2])).toEqual([{ n: 2 }]);
    memo.clear();
    expect(await memo.query("SELECT ?", [1])).toEqual([{ n: 3 }]);
  });
});
