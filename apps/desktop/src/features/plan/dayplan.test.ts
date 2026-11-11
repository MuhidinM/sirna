import { type DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { type Op, type Row, type SqlValue } from "../../kernel/db";
import { openTestDb } from "../../test/sqlite";
import { ensureDayPlan, isoWeekday, loadPlanInput, weekStart } from "./dayplan";
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
