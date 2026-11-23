import { type DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { type Op, type Row, type SqlValue } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import {
  ensureDayPlan,
  healPlans,
  isoWeekday,
  loadPlanInput,
  type OpenTaskRow,
  replanDay,
  startingNow,
  taskOnDay,
  weekStart,
} from "./dayplan";
import { deleteOps } from "./edit";
import { DEFAULT_ANSWERS } from "./routine";
import { setupOps } from "./setup";

const NOW = Date.parse("2026-11-11T12:00:00+03:00"); // Wednesday

/** Applies ops the way Rust does, enough for these tests (inserts and upserts). */
function apply(db: DatabaseSync, ops: Op[]) {
  for (const op of ops) {
    if (op.op === "delete") {
      db.prepare(`UPDATE ${op.table} SET deleted_at = 1 WHERE id = ?`).run(op.id);
      continue;
    }
    const idColumn = op.table === "core_settings" ? "key" : "id";
    const values: Record<string, SqlValue> = { ...op.values };
    const exists = db.prepare(`SELECT 1 FROM ${op.table} WHERE ${idColumn} = ?`).get(op.id);
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
