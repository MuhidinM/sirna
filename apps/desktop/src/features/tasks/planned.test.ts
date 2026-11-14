import { describe, expect, it } from "vitest";

import { type Op } from "../../kernel/db";
import { migrations, openTestDb } from "../../test/sqlite";
import { OPEN_TASKS_SQL } from "../plan/dayplan";
import { carryOps, OPEN_DUE_SQL } from "../review/review";
import { type TaskListRow, taskDraftOf, taskEditOps, TASKS_SQL } from "./list";
import { DUE_SQL, todayTopSql } from "./today";

/** Applies update ops the way db_tx does for these columns. */
function apply(db: ReturnType<typeof openTestDb>, ops: Op[]) {
  for (const op of ops) {
    if (op.op !== "update") throw new Error(`unexpected ${op.op}`);
    const cols = Object.keys(op.values);
    db.prepare(`UPDATE ${op.table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(
      ...(Object.values(op.values) as (string | number | null)[]),
      op.id,
    );
  }
}

const ids = (rows: unknown[]) => rows.map((row) => (row as { id: string }).id);

function withTask(due: string | null) {
  const db = openTestDb();
  db.prepare(
    "INSERT INTO task_items (id, title, status, due_date, created_at, updated_at) VALUES ('cv', 'Send CV', 'todo', ?, 0, 0)",
  ).run(due);
  return db;
}

describe("a task's day apart from its deadline (T-050)", () => {
  it("keeps the deadline when the night review moves a task to tomorrow", () => {
    const db = withTask("2026-11-12");
    apply(db, carryOps([{ id: "cv", carries: 0 }], "2026-11-13"));
    const row = db.prepare("SELECT due_date, planned_date, carries FROM task_items").get();
    expect(row).toEqual({ due_date: "2026-11-12", planned_date: "2026-11-13", carries: 1 });
  });

  it("puts a moved task on the new day's lists, not today's", () => {
    const db = withTask("2026-11-12");
    apply(db, carryOps([{ id: "cv", carries: 0 }], "2026-11-13"));
    const dayStart = (date: string) => Date.parse(`${date}T03:00:00+03:00`);
    for (const [date, expected] of [
      ["2026-11-12", []],
      ["2026-11-13", ["cv"]],
    ] as const) {
      expect(ids(db.prepare(OPEN_DUE_SQL).all(date))).toEqual(expected);
      expect(ids(db.prepare(DUE_SQL).all(date))).toEqual(expected);
      expect(ids(db.prepare(todayTopSql).all(date, dayStart(date)))).toEqual(expected);
    }
  });

  it("keeps a task moved to a later day out of today's plan", () => {
    const db = withTask("2026-11-30");
    apply(db, carryOps([{ id: "cv", carries: 0 }], "2026-11-13"));
    expect(ids(db.prepare(OPEN_TASKS_SQL).all("2026-11-12"))).toEqual([]);
    expect(ids(db.prepare(OPEN_TASKS_SQL).all("2026-11-13"))).toEqual(["cv"]);
    // A task with no planned day is planned whenever there is time.
    const free = withTask(null);
    expect(ids(free.prepare(OPEN_TASKS_SQL).all("2026-11-12"))).toEqual(["cv"]);
  });

  it("puts the task on the date you type when you edit its deadline, and trusts it again", () => {
    const db = withTask("2026-11-12");
    db.prepare("UPDATE task_items SET planned_date = '2026-11-14', deadline_stale = 1").run();
    const [row] = db.prepare(TASKS_SQL).all('["todo"]', 0) as unknown as TaskListRow[];
    if (!row) throw new Error("no row");
    apply(db, taskEditOps(row, { ...taskDraftOf(row), due: "2026-11-20" }, 0));
    expect(
      db.prepare("SELECT due_date, planned_date, deadline_stale FROM task_items").get(),
    ).toEqual({ due_date: "2026-11-20", planned_date: null, deadline_stale: 0 });
  });

  it("saving the form without a new date only confirms the deadline", () => {
    const db = withTask("2026-11-12");
    db.prepare("UPDATE task_items SET planned_date = '2026-11-14', deadline_stale = 1").run();
    const [row] = db.prepare(TASKS_SQL).all('["todo"]', 0) as unknown as TaskListRow[];
    if (!row) throw new Error("no row");
    apply(db, taskEditOps(row, taskDraftOf(row), 0));
    expect(db.prepare("SELECT planned_date, deadline_stale FROM task_items").get()).toEqual({
      planned_date: "2026-11-14",
      deadline_stale: 0,
    });
  });

  it("marks deadlines an old carry may have rewritten, once, when upgrading", () => {
    const db = openTestDb({ migrate: false });
    const all = migrations();
    const upTo = all.findIndex((m) => m.name.startsWith("0017"));
    for (const migration of all.slice(0, upTo)) db.exec(migration.sql);
    const add = db.prepare(
      "INSERT INTO task_items (id, title, status, due_date, carries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)",
    );
    add.run("carried", "carried", "todo", "2026-11-13", 2);
    add.run("fresh", "fresh", "todo", "2026-11-20", 0);
    add.run("done", "done", "done", "2026-11-01", 1);
    for (const migration of all.slice(upTo)) db.exec(migration.sql);
    expect(
      db.prepare("SELECT id, planned_date, deadline_stale FROM task_items ORDER BY id").all(),
    ).toEqual([
      { id: "carried", planned_date: "2026-11-13", deadline_stale: 1 },
      { id: "done", planned_date: null, deadline_stale: 0 },
      { id: "fresh", planned_date: null, deadline_stale: 0 },
    ]);
  });
});
